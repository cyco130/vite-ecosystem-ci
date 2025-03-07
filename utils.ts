import path from 'path'
import fs from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { execaCommand } from 'execa'
import {
	EnvironmentData,
	Overrides,
	ProcessEnv,
	RepoOptions,
	RunOptions,
	Task,
} from './types'
//eslint-disable-next-line n/no-unpublished-import
import { detect } from '@antfu/ni'
import actionsCore from '@actions/core'

const isGitHubActions = !!process.env.GITHUB_ACTIONS

let vitePath: string
let cwd: string
let env: ProcessEnv

function cd(dir: string) {
	cwd = path.resolve(cwd, dir)
}

export async function $(literals: TemplateStringsArray, ...values: any[]) {
	const cmd = literals.reduce(
		(result, current, i) =>
			result + current + (values?.[i] != null ? `${values[i]}` : ''),
		'',
	)

	if (isGitHubActions) {
		actionsCore.startGroup(`${cwd} $> ${cmd}`)
	} else {
		console.log(`${cwd} $> ${cmd}`)
	}

	const proc = execaCommand(cmd, {
		env,
		stdio: 'pipe',
		cwd,
	})
	proc.stdin && process.stdin.pipe(proc.stdin)
	proc.stdout && proc.stdout.pipe(process.stdout)
	proc.stderr && proc.stderr.pipe(process.stderr)
	const result = await proc

	if (isGitHubActions) {
		actionsCore.endGroup()
	}

	return result.stdout
}

export async function setupEnvironment(): Promise<EnvironmentData> {
	// @ts-expect-error import.meta
	const root = dirnameFrom(import.meta.url)
	const workspace = path.resolve(root, 'workspace')
	vitePath = path.resolve(workspace, 'vite')
	cwd = process.cwd()
	env = {
		...process.env,
		CI: 'true',
		TURBO_FORCE: 'true', // disable turbo caching, ecosystem-ci modifies things and we don't want replays
		YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', // to avoid errors with mutated lockfile due to overrides
		NODE_OPTIONS: '--max-old-space-size=6144', // GITHUB CI has 7GB max, stay below
	}
	return { root, workspace, vitePath, cwd, env }
}

export async function setupRepo(options: RepoOptions) {
	if (options.branch == null) {
		options.branch = 'main'
	}
	if (options.shallow == null) {
		options.shallow = true
	}

	let { repo, commit, branch, tag, dir, shallow } = options
	if (!dir) {
		throw new Error('setupRepo must be called with options.dir')
	}
	if (!repo.includes(':')) {
		repo = `https://github.com/${repo}.git`
	}

	let needClone = true
	if (fs.existsSync(dir)) {
		const _cwd = cwd
		cd(dir)
		let currentClonedRepo: string | undefined
		try {
			currentClonedRepo = await $`git ls-remote --get-url`
		} catch {
			// when not a git repo
		}
		cd(_cwd)

		if (repo === currentClonedRepo) {
			needClone = false
		} else {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	}

	if (needClone) {
		await $`git -c advice.detachedHead=false clone ${
			shallow ? '--depth=1 --no-tags' : ''
		} --branch ${tag || branch} ${repo} ${dir}`
	}
	cd(dir)
	await $`git clean -fdxq`
	await $`git fetch ${shallow ? '--depth=1 --no-tags' : '--tags'} origin ${
		tag ? `tag ${tag}` : `${commit || branch}`
	}`
	if (shallow) {
		await $`git -c advice.detachedHead=false checkout ${
			tag ? `tags/${tag}` : `${commit || branch}`
		}`
	} else {
		await $`git checkout ${branch}`
		await $`git merge FETCH_HEAD`
		if (tag || commit) {
			await $`git reset --hard ${tag || commit}`
		}
	}
}

function toCommand(
	task: Task | Task[] | void,
): ((scripts: any) => Promise<any>) | void {
	return async (scripts: any) => {
		const tasks = Array.isArray(task) ? task : [task]
		for (const task of tasks) {
			if (task == null || task === '') {
				continue
			} else if (typeof task === 'string') {
				const scriptOrBin = task.trim().split(/\s+/)[0]
				await (scripts?.[scriptOrBin] != null ? $`nr ${task}` : $`${task}`)
			} else if (typeof task === 'function') {
				await task()
			} else {
				throw new Error(
					`invalid task, expected string or function but got ${typeof task}: ${task}`,
				)
			}
		}
	}
}

export async function runInRepo(options: RunOptions & RepoOptions) {
	if (options.verify == null) {
		options.verify = true
	}
	if (options.skipGit == null) {
		options.skipGit = false
	}
	if (options.branch == null) {
		options.branch = 'main'
	}
	const {
		build,
		test,
		repo,
		branch,
		tag,
		commit,
		skipGit,
		verify,
		beforeInstall,
		beforeBuild,
		beforeTest,
	} = options
	const beforeInstallCommand = toCommand(beforeInstall)
	const beforeBuildCommand = toCommand(beforeBuild)
	const beforeTestCommand = toCommand(beforeTest)
	const buildCommand = toCommand(build)
	const testCommand = toCommand(test)
	const dir = path.resolve(
		options.workspace,
		options.dir || repo.substring(repo.lastIndexOf('/') + 1),
	)

	if (!skipGit) {
		await setupRepo({ repo, dir, branch, tag, commit })
	} else {
		cd(dir)
	}

	const pkgFile = path.join(dir, 'package.json')
	const pkg = JSON.parse(await fs.promises.readFile(pkgFile, 'utf-8'))

	await beforeInstallCommand?.(pkg.scripts)

	if (verify && test) {
		await $`ni --frozen`
		await beforeBuildCommand?.(pkg.scripts)
		await buildCommand?.(pkg.scripts)
		await beforeTestCommand?.(pkg.scripts)
		await testCommand?.(pkg.scripts)
	}
	let overrides = options.overrides || {}
	if (options.release) {
		if (overrides.vite && overrides.vite !== options.release) {
			throw new Error(
				`conflicting overrides.vite=${overrides.vite} and --release=${options.release} config. Use either one or the other`,
			)
		} else {
			overrides.vite = options.release
		}
	} else {
		overrides.vite ||= `${options.vitePath}/packages/vite`

		overrides[
			`@vitejs/plugin-legacy`
		] ||= `${options.vitePath}/packages/plugin-legacy`
		if (options.viteMajor < 4) {
			overrides[
				`@vitejs/plugin-vue`
			] ||= `${options.vitePath}/packages/plugin-vue`
			overrides[
				`@vitejs/plugin-vue-jsx`
			] ||= `${options.vitePath}/packages/plugin-vue-jsx`
			overrides[
				`@vitejs/plugin-react`
			] ||= `${options.vitePath}/packages/plugin-react`
			// vite-3 dependency setup could have caused problems if we don't synchronize node versions
			// vite-4 uses an optional peerDependency instead so keep project types
			const typesNodePath = fs.realpathSync(
				`${options.vitePath}/node_modules/@types/node`,
			)
			overrides[`@types/node`] ||= `${typesNodePath}`
		} else {
			// starting with vite-4, we apply automatic overrides
			const localOverrides = await buildOverrides(pkg, options, overrides)
			cd(dir) // buildOverrides changed dir, change it back
			overrides = {
				...overrides,
				...localOverrides,
			}
		}
	}
	await applyPackageOverrides(dir, pkg, overrides)
	await beforeBuildCommand?.(pkg.scripts)
	await buildCommand?.(pkg.scripts)
	if (test) {
		await beforeTestCommand?.(pkg.scripts)
		await testCommand?.(pkg.scripts)
	}
	return { dir }
}

export async function setupViteRepo(options: Partial<RepoOptions>) {
	const repo = options.repo || 'vitejs/vite'
	await setupRepo({
		repo,
		dir: vitePath,
		branch: 'main',
		shallow: true,
		...options,
	})

	try {
		const rootPackageJsonFile = path.join(vitePath, 'package.json')
		const rootPackageJson = JSON.parse(
			await fs.promises.readFile(rootPackageJsonFile, 'utf-8'),
		)
		const viteMonoRepoNames = ['@vitejs/vite-monorepo', 'vite-monorepo']
		const { name } = rootPackageJson
		if (!viteMonoRepoNames.includes(name)) {
			throw new Error(
				`expected  "name" field of ${repo}/package.json to indicate vite monorepo, but got ${name}.`,
			)
		}
	} catch (e) {
		throw new Error(`Non-vite repository was cloned by setupViteRepo. (${e})`)
	}
}

export async function getPermanentRef() {
	cd(vitePath)
	try {
		const ref = await $`git log -1 --pretty=format:%h`
		return ref
	} catch (e) {
		console.warn(`Failed to obtain perm ref. ${e}`)
		return undefined
	}
}

export async function buildVite({ verify = false }) {
	cd(vitePath)
	await $`ni --frozen`
	await $`nr build`
	if (verify) {
		await $`nr test`
	}
}

export async function bisectVite(
	good: string,
	runSuite: () => Promise<Error | void>,
) {
	// sometimes vite build modifies files in git, e.g. LICENSE.md
	// this would stop bisect, so to reset those changes
	const resetChanges = async () => $`git reset --hard HEAD`

	try {
		cd(vitePath)
		await resetChanges()
		await $`git bisect start`
		await $`git bisect bad`
		await $`git bisect good ${good}`
		let bisecting = true
		while (bisecting) {
			const commitMsg = await $`git log -1 --format=%s`
			const isNonCodeCommit = commitMsg.match(/^(?:release|docs)[:(]/)
			if (isNonCodeCommit) {
				await $`git bisect skip`
				continue // see if next commit can be skipped too
			}
			const error = await runSuite()
			cd(vitePath)
			await resetChanges()
			const bisectOut = await $`git bisect ${error ? 'bad' : 'good'}`
			bisecting = bisectOut.substring(0, 10).toLowerCase() === 'bisecting:' // as long as git prints 'bisecting: ' there are more revisions to test
		}
	} catch (e) {
		console.log('error while bisecting', e)
	} finally {
		try {
			cd(vitePath)
			await $`git bisect reset`
		} catch (e) {
			console.log('Error while resetting bisect', e)
		}
	}
}

function isLocalOverride(v: string): boolean {
	if (!v.includes('/') || v.startsWith('@')) {
		// not path-like (either a version number or a package name)
		return false
	}
	try {
		return !!fs.lstatSync(v)?.isDirectory()
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e
		}
		return false
	}
}
export async function applyPackageOverrides(
	dir: string,
	pkg: any,
	overrides: Overrides = {},
) {
	const useFileProtocol = (v: string) =>
		isLocalOverride(v) ? `file:${path.resolve(v)}` : v
	// remove boolean flags
	overrides = Object.fromEntries(
		Object.entries(overrides)
			//eslint-disable-next-line @typescript-eslint/no-unused-vars
			.filter(([key, value]) => typeof value === 'string')
			.map(([key, value]) => [key, useFileProtocol(value as string)]),
	)
	await $`git clean -fdxq` // remove current install

	const agent = await detect({ cwd: dir, autoInstall: false })

	// Remove version from agent string:
	// yarn@berry => yarn
	// pnpm@6, pnpm@7 => pnpm
	const pm = agent?.split('@')[0]

	if (pm === 'pnpm') {
		const version = await $`pnpm --version`
		// avoid bug with absolute overrides in pnpm 7.18.0
		if (version === '7.18.0') {
			console.warn(
				'detected pnpm@7.18.0, changing pkg.packageManager and pkg.engines.pnpm to enforce use of pnpm@7.18.1',
			)
			// corepack reads this and uses pnpm 7.18.1 then
			pkg.packageManager = 'pnpm@7.18.1'
			if (!pkg.engines) {
				pkg.engines = {}
			}
			pkg.engines.pnpm = '7.18.1'
		}
		if (!pkg.devDependencies) {
			pkg.devDependencies = {}
		}
		pkg.devDependencies = {
			...pkg.devDependencies,
			...overrides, // overrides must be present in devDependencies or dependencies otherwise they may not work
		}
		if (!pkg.pnpm) {
			pkg.pnpm = {}
		}
		pkg.pnpm.overrides = {
			...pkg.pnpm.overrides,
			...overrides,
		}
	} else if (pm === 'yarn') {
		pkg.resolutions = {
			...pkg.resolutions,
			...overrides,
		}
	} else if (pm === 'npm') {
		pkg.overrides = {
			...pkg.overrides,
			...overrides,
		}
		// npm does not allow overriding direct dependencies, force it by updating the blocks themselves
		for (const [name, version] of Object.entries(overrides)) {
			if (pkg.dependencies?.[name]) {
				pkg.dependencies[name] = version
			}
			if (pkg.devDependencies?.[name]) {
				pkg.devDependencies[name] = version
			}
		}
	} else {
		throw new Error(`unsupported package manager detected: ${pm}`)
	}
	const pkgFile = path.join(dir, 'package.json')
	await fs.promises.writeFile(pkgFile, JSON.stringify(pkg, null, 2), 'utf-8')

	// use of `ni` command here could cause lockfile violation errors so fall back to native commands that avoid these
	if (pm === 'pnpm') {
		await $`pnpm install --prefer-frozen-lockfile --prefer-offline --strict-peer-dependencies false`
	} else if (pm === 'yarn') {
		await $`yarn install`
	} else if (pm === 'npm') {
		await $`npm install`
	}
}

export function dirnameFrom(url: string) {
	return path.dirname(fileURLToPath(url))
}

export function parseViteMajor(vitePath: string): number {
	const content = fs.readFileSync(
		path.join(vitePath, 'packages', 'vite', 'package.json'),
		'utf-8',
	)
	const pkg = JSON.parse(content)
	return parseMajorVersion(pkg.version)
}

export function parseMajorVersion(version: string) {
	return parseInt(version.split('.', 1)[0], 10)
}

async function buildOverrides(
	pkg: any,
	options: RunOptions,
	repoOverrides: Overrides,
) {
	const { root } = options
	const buildsPath = path.join(root, 'builds')
	const buildFiles: string[] = fs
		.readdirSync(buildsPath)
		.filter((f: string) => !f.startsWith('_') && f.endsWith('.ts'))
		.map((f) => path.join(buildsPath, f))
	const buildDefinitions: {
		packages: { [key: string]: string }
		build: (options: RunOptions) => Promise<{ dir: string }>
		dir?: string
	}[] = await Promise.all(buildFiles.map((f) => import(pathToFileURL(f).href)))
	const deps = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
	])

	const needsOverride = (p: string) =>
		repoOverrides[p] === true || (deps.has(p) && repoOverrides[p] == null)
	const buildsToRun = buildDefinitions.filter(({ packages }) =>
		Object.keys(packages).some(needsOverride),
	)
	const overrides: Overrides = {}
	for (const buildDef of buildsToRun) {
		const { dir } = await buildDef.build({
			root: options.root,
			workspace: options.workspace,
			vitePath: options.vitePath,
			viteMajor: options.viteMajor,
			skipGit: options.skipGit,
			release: options.release,
			verify: options.verify,
			// do not pass along scripts
		})
		for (const [name, path] of Object.entries(buildDef.packages)) {
			if (needsOverride(name)) {
				overrides[name] = `${dir}/${path}`
			}
		}
	}
	return overrides
}

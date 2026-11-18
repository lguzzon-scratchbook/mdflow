import { delimiter, join, sep } from "path";
import { homedir } from "os";
import { getDeclaredFlowDirectories } from "./config";
import { resolveProjectRootWith } from "./project-root";
import { ConfigurationError } from "./errors";
import type { SystemEnvironment } from "./system-environment";

/** Caller context resolveFilePath needs (was CliRunner this-access). */
export interface ResolveFileDeps {
	fs: SystemEnvironment["fs"];
	cwd: string;
	configCwd: string;
	pathEnv: string | undefined;
}

// A bare token like `md reviw` is more likely a mistyped command or flow
// name than a file path, so the error should point at both namespaces.
export function fileNotFoundMessage(requested: string, resolved: string): string {
	const looksLikeName =
		!requested.includes("/") &&
		!requested.includes("\\") &&
		!/\.md$/i.test(requested);
	if (looksLikeName) {
		return `No command or flow named "${requested}". Run 'md help' for commands, or 'md roster --json' to list flows.`;
	}
	return `File not found: ${resolved}`;
}

/**
 * Resolve file path by checking multiple locations in order:
 * 1. As-is (absolute path or relative to cwd)
 * 2. Project flow roster: ./flows/<filename>
 * 3. Legacy project agents: ./.mdflow/<filename>
 *    3b. Project registry installs: ./.mdflow/registry/<filename>
 * 4. User flows: ~/.mdflow/flows/<filename>
 *    4b. User registry installs: ~/.mdflow/registry/<filename>
 * 5. Config-declared roster directories (flows.directories)
 * 6. Legacy user agents: ~/.mdflow/<filename>
 * 7. PATH directories (for files without path separators)
 *
 * Simple flow names may omit the .md extension (`md review`).
 */
export async function resolveFilePath(filePath: string, deps: ResolveFileDeps): Promise<string> {
	const simpleName = !filePath.includes("/") && !filePath.includes(sep);
	const candidateNames =
		simpleName && !filePath.toLowerCase().endsWith(".md")
			? [filePath, `${filePath}.md`]
			: [filePath];

	// 1. Try as-is (could be absolute or relative from cwd)
	for (const candidate of candidateNames) {
		if (await deps.fs.exists(candidate)) {
			return candidate;
		}
	}

	// Only search directories for simple filenames (no path separators)
	// Check for both forward slash and platform-specific separator for cross-platform support
	if (simpleName) {
		const { projectRoot } = await resolveProjectRootWith(
			deps.cwd,
			deps.fs,
		);

		// 2. Try the canonical roster at the nearest project root.
		for (const candidate of candidateNames) {
			const rosterPath = join(projectRoot, "flows", candidate);
			if (await deps.fs.exists(rosterPath)) {
				return rosterPath;
			}
		}

		// 3. Try the legacy project directory at the same project root.
		for (const candidate of candidateNames) {
			const projectPath = join(projectRoot, ".mdflow", candidate);
			if (await deps.fs.exists(projectPath)) {
				return projectPath;
			}
		}

		// 3b. Registry installs at the project scope. `md install` puts
		// flows here and `md list`/the roster surface them — chaos round 4
		// found them unreachable by name (the runner never looked).
		// Registry provenance (remote hooks trust) is enforced downstream
		// via isRegistryFlowPath, not by hiding the file.
		for (const candidate of candidateNames) {
			const projectRegistryPath = join(
				projectRoot,
				".mdflow",
				"registry",
				candidate,
			);
			if (await deps.fs.exists(projectRegistryPath)) {
				return projectRegistryPath;
			}
		}

		// 4. Try the canonical user roster: ~/.mdflow/flows/
		for (const candidate of candidateNames) {
			const userFlowsPath = join(homedir(), ".mdflow", "flows", candidate);
			if (await deps.fs.exists(userFlowsPath)) {
				return userFlowsPath;
			}
		}

		// 4b. Registry installs at the user scope.
		for (const candidate of candidateNames) {
			const userRegistryPath = join(
				homedir(),
				".mdflow",
				"registry",
				candidate,
			);
			if (await deps.fs.exists(userRegistryPath)) {
				return userRegistryPath;
			}
		}

		// 5. Try config-declared roster directories
		try {
			const declared = await getDeclaredFlowDirectories({
				cwd: deps.configCwd,
			});
			for (const dir of [...declared.project, ...declared.global]) {
				for (const candidate of candidateNames) {
					const declaredPath = join(dir, candidate);
					if (await deps.fs.exists(declaredPath)) {
						return declaredPath;
					}
				}
			}
		} catch {
			// Declared directories are best-effort for name resolution; a
			// broken config is reported by the main config load path.
		}

		// 6. Try the legacy user directory: ~/.mdflow/
		for (const candidate of candidateNames) {
			const userPath = join(homedir(), ".mdflow", candidate);
			if (await deps.fs.exists(userPath)) {
				return userPath;
			}
		}

		// 7. Try $PATH directories
		// Use path.delimiter for cross-platform support (: on Unix, ; on Windows)
		const pathDirs = (deps.pathEnv || "").split(delimiter);
		for (const dir of pathDirs) {
			if (!dir) continue;
			for (const candidate of candidateNames) {
				const pathFilePath = join(dir, candidate);
				if (await deps.fs.exists(pathFilePath)) {
					return pathFilePath;
				}
			}
		}
	}

	// Not found anywhere - return original for error message
	return filePath;
}

export function parseRegistryArgs(args: string[]): {
	scope?: "project" | "user";
	positional: string[];
} {
	let scope: "project" | "user" | undefined;
	const positional: string[] = [];

	for (const arg of args) {
		if (arg === "--project" || arg === "-p") {
			scope = "project";
			continue;
		}
		if (arg === "--global" || arg === "-g" || arg === "--user") {
			scope = "user";
			continue;
		}
		positional.push(arg);
	}

	return { scope, positional };
}

/**
 * Reject unknown flags on registry subcommands (install/remove/list).
 * Their only valid positionals are URLs and flow names, which never begin
 * with "-", so a dash-prefixed positional is a typo'd/unknown flag — e.g.
 * `md remove --gobal name` used to silently remove from the wrong scope
 * (chaos round 6). Only `--json` is allowed alongside (handled elsewhere).
 */
export function assertNoUnknownRegistryFlags(
	subcommand: string,
	positional: string[],
): void {
	const unknown = positional.find(
		(arg) => arg.startsWith("-") && arg !== "--json",
	);
	if (unknown) {
		throw new ConfigurationError(
			`Unknown ${subcommand} option: ${unknown}. ` +
				`Valid flags: --global (-g) / --project (-p). Run 'md ${subcommand} --help'.`,
			1,
		);
	}
}

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PACK_DIR = "/opt/staka/skills";

export function ensureOrgSkillSymlink(): void {
	const link = join(homedir(), ".agents", "skills", "staka");

	if (existsSync(PACK_DIR) === false) return;

	const parent = dirname(link);
	if (existsSync(parent) === false) {
		mkdirSync(parent, { recursive: true });
	}

	if (existsSync(link)) {
		try {
			if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === PACK_DIR) {
				return;
			}
		} catch {
			// broken symlink, recreate
		}
	}

	try {
		symlinkSync(PACK_DIR, link, "dir");
	} catch {
		// permission denied or race - non-fatal
	}
}

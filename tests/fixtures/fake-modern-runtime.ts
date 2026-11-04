import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
if (process.argv[2] === "build-info")
  console.log(
    readFileSync(join(dirname(process.execPath), "../build.json"), "utf8"),
  );
else if (process.argv[2] === "hook") {
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  writeFileSync(
    join(process.env.CODEX_HOME!, "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: process.execPath + " hook pre-pr" }] },
        ],
      },
    }),
  );
} else process.exitCode = 1;

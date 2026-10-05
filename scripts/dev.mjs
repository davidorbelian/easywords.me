import { spawn } from "node:child_process";

const children = [
  spawn("node", ["scripts/build.mjs", "--watch"], { stdio: "inherit" }),
  spawn(
    "node",
    ["--env-file-if-exists=.env", "--watch-path=src/server", "--watch-path=src/shared", "src/server/main.ts"],
    {
      stdio: "inherit",
    },
  ),
];
const stop = () => children.forEach((child) => child.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

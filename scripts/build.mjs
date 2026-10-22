import { cp, mkdir, rm } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const out = "dist/web";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const copyStatic = () =>
  Promise.all(
    ["index.html", "admin.html", "styles.css", "admin.css", "favicon.svg"].map((file) =>
      cp(`src/web/${file}`, `${out}/${file}`),
    ),
  );

const options = {
  entryPoints: ["src/web/main.ts", "src/web/admin.ts"],
  outdir: out,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
  plugins: [{ name: "static", setup: (build) => build.onEnd(async () => void (await copyStatic())) }],
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const out = "dist/web";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Built files carry a hash of their content in the name, so browsers may keep them for good,
// and a new page never meets an old file.
async function writePages(metafile) {
  const names = new Map();
  for (const [file, { entryPoint }] of Object.entries(metafile.outputs)) {
    if (entryPoint) names.set(basename(entryPoint).replace(/\.ts$/, ".js"), basename(file));
  }
  await cp("src/web/favicon.svg", `${out}/favicon.svg`);
  for (const page of ["index.html", "admin.html"]) {
    let html = await readFile(`src/web/${page}`, "utf8");
    for (const [name, hashed] of names) html = html.replaceAll(`"${name}"`, `"${hashed}"`);
    await writeFile(`${out}/${page}`, html);
  }
}

const options = {
  entryPoints: ["src/web/main.ts", "src/web/admin.ts", "src/web/styles.css", "src/web/admin.css"],
  entryNames: "[name]-[hash]",
  outdir: out,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: watch,
  metafile: true,
  logLevel: "info",
  plugins: [
    {
      name: "pages",
      setup: (build) =>
        build.onEnd(async (result) => {
          if (result.metafile) await writePages(result.metafile);
        }),
    },
  ],
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);

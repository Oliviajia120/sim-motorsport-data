import * as esbuild from "esbuild";
import fs from "node:fs";

const result = await esbuild.build({
  entryPoints: ["src/standalone.ts"],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  write: false,
  legalComments: "none",
});
const js = result.outputFiles[0].text;
const css = fs.readFileSync("src/app.css", "utf8");
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sim Motorsport Data</title>
<style>
${css}</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
${js}
</script>
</body>
</html>
`;
fs.writeFileSync("index.html", html);
console.log(`wrote index.html (${html.length} bytes)`);

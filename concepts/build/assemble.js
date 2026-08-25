// Inlines engine.js and the data bundle into the v1-ops-terminal.html template,
// producing the single self-contained static file that gets deployed.
const fs = require("fs");
const path = require("path");

const dataJson = fs.readFileSync(path.join(__dirname, "data-bundle-v2.json"), "utf-8");
const engineJs = fs.readFileSync(path.join(__dirname, "engine.js"), "utf-8");
const outDir = path.join(__dirname, "..", "dist");
fs.mkdirSync(outDir, { recursive: true });

const file = "v1-ops-terminal.html";
const template = fs.readFileSync(path.join(__dirname, file), "utf-8")
	.replace("__ENGINE__", () => engineJs)
	.replace("__DATA_V2__", () => dataJson);
fs.writeFileSync(path.join(outDir, file), template);
console.log(file, "->", "dist/" + file, Math.round(template.length / 1024) + "KB");

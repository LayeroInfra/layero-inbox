// Кладёт html2canvas-pro в public/vendor: embed.js грузит его по требованию
// с нашего домена, только когда посетитель нажал кнопку.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public/vendor", { recursive: true });
copyFileSync("node_modules/html2canvas-pro/dist/html2canvas-pro.min.js", "public/vendor/html2canvas-pro.min.js");

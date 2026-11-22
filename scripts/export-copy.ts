/** Writes COPY.md from content/site.ts. Run: npm run copy:export */
import { writeFileSync } from "node:fs";
import { renderCopyMd } from "./copy-md";

writeFileSync("COPY.md", renderCopyMd());
console.log("COPY.md written");

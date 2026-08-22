import { execFileSync } from "node:child_process"

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
})
const result = JSON.parse(output)[0]
const files = result.files.map((entry) => entry.path)
const required = ["package.json", "README.md", "LICENSE", "dist/cli.js"]
const forbidden =
  /(^|\/)(test|tests|node_modules|\.git)(\/|$)|\.map$|\.tsbuildinfo$|\.dev\.vars/

for (const file of required) {
  if (!files.includes(file)) throw new Error(`npm pack is missing ${file}`)
}
for (const file of files) {
  if (forbidden.test(file))
    throw new Error(`npm pack contains forbidden ${file}`)
}

console.log(`npm pack contents ok (${files.length} files)`)

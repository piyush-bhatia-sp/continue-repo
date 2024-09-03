const { exec } = require("child_process");
const fs = require("fs");

let command = "npx vsce package --out ./build patch --no-dependencies"; // --yarn";

exec(command, (error) => {
  if (error) {
    throw error;
  }
  console.log(
    "vsce package completed - extension created at extensions/vscode/build/continue-{version}.vsix",
  );
});

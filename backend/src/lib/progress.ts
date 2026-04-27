import * as fs from "node:fs";

export const loadProgress = (filePath: string): Set<string> => {
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return new Set(data);
  }
  return new Set();
};

export const saveProgress = (filePath: string, completed: Set<string>) => {
  fs.writeFileSync(filePath, JSON.stringify([...completed]));
};

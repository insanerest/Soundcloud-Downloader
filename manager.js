class JSONmanage {
  constructor(file) {
    this.fs = require("fs/promises");
    this.file = file || "./track.json";
    this.readFile = this.fs.readFile;
    this.writeFile = this.fs.writeFile;
  }
  async writeJSON(content) {
    let oldJSON = JSON.stringify({});
    try {
      oldJSON = await this.readFile(this.file, "utf-8");
      if (!oldJSON) {
        oldJSON = JSON.stringify({});
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    await this.writeFile(this.file, this.constructJSON(oldJSON, content), {
      flag: "w",
    });
  }

  constructJSON(old, add) {
    console.log(old);
    const newJSON = JSON.parse(old);
    const keys = Object.keys(add);
    keys.forEach((key) => {
      newJSON[key] = add[key];
    });
    return JSON.stringify(newJSON, null, 2);
  }

  async hasValue(value) {
    try {
      const parsedJSON = await this.getFile();
      return Object.values(parsedJSON).some((v) => v === value);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return false;
    }
  }
  async getKeyOfValue(value) {
    try {
      const parsedJSON = await this.getFile();
      return Object.keys(parsedJSON).find((k) => parsedJSON[k] === value);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async getFile() {
    try {
      const content = await this.readFile(this.file, "utf-8");
      console.log(content)
      return JSON.parse(content || {});
    } catch (err) {
      if (err.code === "ENOENT") return JSON.parse({});
      throw err;
    }
  }
}
module.exports = JSONmanage;

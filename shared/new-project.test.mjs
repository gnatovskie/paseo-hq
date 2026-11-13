import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_PROJECT_DRAFT, projectAddInput, projectDraftFolder, projectDraftRoot, repoFolderName, splitFolderPath } from "./new-project.ts";

const draft = (patch) => ({ ...EMPTY_PROJECT_DRAFT, ...patch });

test("folder paths split into parent and folder", () => {
  assert.deepEqual(splitFolderPath("~/repos/my-app/"), { parentPath: "~/repos", folderName: "my-app" });
  assert.deepEqual(splitFolderPath("/srv"), { parentPath: "/", folderName: "srv" });
  assert.deepEqual(splitFolderPath("app"), { parentPath: "", folderName: "app" });
});

test("repository folder comes from any link form", () => {
  assert.equal(repoFolderName("git@github.com:gnatovskie/paseo-hq.git"), "paseo-hq");
  assert.equal(repoFolderName("https://gitlab.com/org/sub/tool/"), "tool");
  assert.equal(repoFolderName("owner/repo"), "repo");
});

test("an existing folder is added by path with an optional name", () => {
  assert.deepEqual(projectAddInput(draft({ path: "~/repos/site/", name: " Сайт " }), "~/repos"), { mode: "existing", path: "~/repos/site", customName: "Сайт" });
  assert.throws(() => projectAddInput(draft({ path: " " }), "~/repos"), /папку на сервере/);
});

test("a new folder is one path, a bare name lands in the default parent", () => {
  assert.deepEqual(projectAddInput(draft({ source: "create", path: "~/work/new-app", initGit: false }), "~/repos"),
    { mode: "create", parentPath: "~/work", folderName: "new-app", customName: undefined, initGit: false });
  assert.deepEqual(projectAddInput(draft({ source: "create", path: "new-app" }), "~/repos"),
    { mode: "create", parentPath: "~/repos", folderName: "new-app", customName: undefined, initGit: true });
  assert.throws(() => projectAddInput(draft({ source: "create", path: "" }), "~/repos"), /путь новой папки/);
});

test("a clone goes to the default parent unless a folder is given", () => {
  const url = "git@github.com:org/tool.git";
  assert.deepEqual(projectAddInput(draft({ source: "clone", repoUrl: url }), "~/repos"),
    { mode: "clone", repoUrl: url, parentPath: "~/repos", customName: undefined });
  assert.equal(projectDraftRoot(draft({ source: "clone", repoUrl: url }), "~/repos/"), "~/repos/tool");
  assert.deepEqual(projectAddInput(draft({ source: "clone", repoUrl: url, path: "~/src/tool2" }), "~/repos"),
    { mode: "clone", repoUrl: url, parentPath: "~/src", folderName: "tool2", customName: undefined });
  assert.equal(projectDraftFolder(draft({ source: "clone", repoUrl: url, path: "~/src/tool2" }), "~/repos"), "tool2");
  assert.throws(() => projectAddInput(draft({ source: "clone" }), "~/repos"), /ссылку/);
});

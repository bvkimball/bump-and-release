const fs = require("fs");
const path = require("path");
const core = require("@actions/core");
// const util = require("util");
const replace = require("replace");
const semver = require("semver");
const got = require("got");
const git = require("simple-git")();
const shell = require("child-process-promise");
const glob = require("fast-glob");
const ghpages = require("gh-pages");

const hasEventFile = fs.existsSync("/github/workflow/event.json");
const event = hasEventFile
  ? JSON.parse(fs.readFileSync("/github/workflow/event.json").toString())
  : null;

const root = path.join(process.cwd(), process.env.ROOT_DIR || "./");
const branch = process.env.GITHUB_REF.split("/").slice(2).join("/");
const pkg = require(path.join(root, "package.json"));
const globalConfig = require(path.join(root, "bump.json"));

const getBranchConfig = async (config) => {
  const internal = config.branches.find((it) => it.name === branch);
  internal.docs = config.docs ? { ...config.docs, ...internal.docs } : false;
  internal.skipChangeLog = !!internal.skipChangeLog;
  return internal;
};

const getLatestFromNPM = async () => {
  const registry = process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org";
  return await got(`${registry}/${pkg.name}/latest`).json();
};

const recommendVersion = async (latest, type, prerelease) => {
  if (type) {
    return semver.inc(latest.version, type, prerelease);
  }
  return latest.version;
};

const getGitHash = async (latest) => {
  // rev-list -n 1 tags/v5.7.0
  const [hash] = await git.raw([
    "rev-list",
    "-n",
    "1",
    `tags/v${latest.version}`,
  ]);
  return hash;
};

const getReleaseType = async (config, latest) => {
  if (config.prerelease) {
    // Use pkg.version because `latest` wont return prerelease tag
    return "prerelease";
  }
  let releaseType = "patch";
  let messages = [];
  if (latest) {
    const hash = latest.gitHead || (await getGitHash(latest));
    if (hash === process.env.GITHUB_SHA)
      return core.info("SHA matches latest release, skipping.");
    if (hash) {
      try {
        let logs = await git.getlog({
          from: hash,
          to: process.env.GITHUB_SHA,
        });
        messages = logs.all.map((r) => r.message + "\n" + r.body);
      } catch (e) {
        core.debug("no logs found");
      }
    }
  }
  if (!messages.length > 0 && event) {
    messages = (event.commits || []).map(
      (commit) => commit.message + "\n" + commit.body
    );
  }

  if (
    messages
      .map((it) => it.includes("BREAKING CHANGE") || it.includes("!:"))
      .includes(true)
  ) {
    releaseType = "major";
  } else if (
    messages.map((it) => it.toLowerCase().startsWith("feat")).includes(true)
  ) {
    releaseType = "minor";
  }
  return releaseType;
};

const bump = async (version, bumpFiles) => {
  const packageFiles = await glob(bumpFiles, { dot: true });
  replace({
    regex: /"version": "[^"]+"/m,
    replacement: `"version": "${version}"`,
    paths: packageFiles,
    recursive: false,
  });

  return packageFiles;
};

async function commitVersion(version, changedFiles) {
  core.info("Committing...");
  await git.commit(`chore(release): ${version}`, [...changedFiles]);
  core.info("Tagging...");
  await git.addAnnotatedTag(`v${version}`, "Version release");
  return version;
}

async function publish(version, bundles) {
  core.info("Publishing...");
  try {
    for (let bundle of bundles) {
      const { stdout } = await shell.exec(`npm publish ${bundle}`);
      core.info(stdout);
    }
  } catch (err) {
    core.error("child processes failed with error code: ", err);
  }
  return version;
}

async function push() {
  core.info("Pushing Changes...");
  await git.push("origin", branch);
  core.info("Pushing Tags...");
  await git.pushTags("origin");
}

async function changelog(version, packageFile, changelogFile) {
  await shell.exec(
    `npx conventional-changelog --pkg ${packageFile} -p angular -i ${changelogFile} -s`
  );
  return version;
}

const deployGithubPages = async (version, docs) => {
  if (docs.build && docs.build.preset) {
    switch (docs.build.preset) {
      case "angular":
        await shell.exec(
          `ng build --prod ${docs.app} --base-href /${docs.dest}/ --deploy-url /${docs.dest}/`
        );
        break;
      default:
        throw new Error("Build Command not defined");
    }
  }
  if (docs.build && docs.build.cmd) {
    await shell.exec(docs.build.cmd);
  } else {
    core.info("No build for docs task specified");
  }

  const dir = path.join(root, docs.dir);
  return await new Promise((resolve, reject) => {
    const dest = docs.dest || ".";
    ghpages.publish(
      dir,
      {
        dest,
        ...docs.options,
        remove: `${dest}/**/*`,
        message: "chore(release): v" + version,
      },
      (err) => {
        if (err) {
          core.error("Error while publishing demo.", err);
          reject(err);
        }
        core.info("Demo published!");
        resolve(version);
      }
    );
  });
};

async function run() {
  try {
    core.info(`running on branch: ${branch}`);
    core.info(`cwd is ${process.cwd()}`);
    core.info(`root directroy is ${root}`);
    core.info(JSON.stringify(globalConfig));
    const config = await getBranchConfig(globalConfig);
    const { docs, skipChangeLog } = config;
    if (config) {
      const latest = await getLatestFromNPM();
      const releaseType = await getReleaseType(config, latest);
      const version = await recommendVersion(
        latest,
        releaseType,
        config.prerelease
      );

      const changedFiles = await bump(version, config.bumpFiles);
      if (!skipChangeLog) {
        const changelogFile = path.join(root, "CHANGELOG.md");
        await changelog(version, changedFiles[0], changelogFile);
        changedFiles.push(changelogFile);
      }

      await commitVersion(version, [...changedFiles]);
      await publish(version, globalConfig.bundles);
      await push();

      if (docs) {
        switch (docs.type) {
          case "ghpages":
            await deployGithubPages(version, docs);
            break;
          default:
            core.warning("Documentation Deploy configuration not valid.");
        }
      }
    } else {
      core.info("Skipped Bump And Release: Branch not configured!");
    }
    core.info("Success!");
  } catch (error) {
    git.reset("hard");
    core.setFailed(error.message);
  }
}

run();

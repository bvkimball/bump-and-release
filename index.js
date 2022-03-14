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

const branch = process.env.GITHUB_REF.split("/").slice(2).join("/");
const root = process.env.GITHUB_WORKSPACE;
const readJSON = (fileName) => {
  const filePath = fileName[0] !== "/" ? path.join(root, fileName) : fileName;
  try {
    const bytes = fs.readFileSync(filePath);
    return JSON.parse(bytes.toString());
  } catch (err) {
    core.warning(`Error reading file: ${filePath}`);
  }
  return {};
};

const event = readJSON("/github/workflow/event.json");
const pkg = readJSON("package.json");
const globalConfig = readJSON("./bump.json");

const spawnWithLogs = async (command) => {
  const [cmd, ...args] = command.match(/('.*?'|".*?"|\S+)/g);
  const spawned = shell.spawn(cmd, args);
  const childProcess = spawned.childProcess;
  core.info(`[${cmd}] childProcess.pid: ${childProcess.pid}`);
  childProcess.stdout.on("data", (data) => {
    core.info(`[${cmd}] stdout: ${data.toString()}`);
  });
  childProcess.stderr.on("data", (data) => {
    core.warning(`[${cmd}] stderr: ${data.toString()}`);
  });
  return spawned;
};

const initialize = async () => {
  const gitUserEmail = core.getInput("git-user-email");
  await git.addConfig("user.email", gitUserEmail);
  await git.addConfig("user.name", "Bump And Release");
  await spawnWithLogs(
    `npm config set //registry.npmjs.org/:_authToken ${process.env.NPM_AUTH_TOKEN}`
  );
};

const getBranchConfig = async (config) => {
  const internal = config.branches.find((it) => it.name === branch);
  internal.docs = config.docs ? { ...config.docs, ...internal.docs } : false;
  internal.skipChangeLog = !!internal.skipChangeLog;
  return internal;
};

const getLatestFromNPM = async (tag = "latest") => {
  try {
    const registry =
      process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org";
    const response = await got(
      `${registry}/~/package/${pkg.name}/dist-tags`
    ).json();
    if (response && response[tag]) return response[tag];
  } catch (e) {
    core.warning(
      `Unable to find latest info in registry, using package.json as fallback.`
    );
  }

  return pkg;
};

const recommendVersion = async (latest, type, prerelease) => {
  if (type) {
    const suggested = semver.inc(latest.version, type, prerelease);
    if (semver.gte(pkg.version, suggested) && prerelease && prerelease.length) {
      return semver.inc(pkg.version, "prerelease", prerelease);
    }
    return suggested;
  }
  return latest.version;
};

const getGitHash = async (latest) => {
  // rev-list -n 1 tags/v5.7.0
  if (latest.gitHead) return latest.gitHead;
  try {
    core.info("Getting latest git hash from tag");
    const hash = await git.revparse([`v${latest.version}`]);
    core.info(hash);
    return hash.trim();
  } catch (e) {
    core.warning(e.message);
    try {
      // Maybe inital commit
      core.info("fallback, get latest git hash from previous commit");
      const hash = await git.revparse([`HEAD^1`]);
      core.info(hash);
      return hash.trim();
    } catch (e) {
      core.info("Can not find hash for latest version");
    }
  }
  return null;
};

const getReleaseType = async (config, latest) => {
  let releaseType = "patch";
  let messages = [];
  if (latest && latest.version) {
    const hash = await getGitHash(latest);
    if (hash === process.env.GITHUB_SHA) {
      core.info("SHA matches latest release, skipping.");
      return;
    }
    if (hash) {
      try {
        core.info(`get logs from ${hash} to ${process.env.GITHUB_SHA}`);
        let logs = await git.log({
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
  if (config.prerelease) {
    // Use pkg.version because `latest` wont return prerelease tag
    return `pre${releaseType}`;
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

async function commitVersion(version) {
  core.info("Committing...");
  await git.add("./*");
  await git.commit(`chore(release): ${version}`);
  core.info("Tagging...");
  await git.addAnnotatedTag(`v${version}`, "Version release");
  return version;
}

async function publish(version, config, bundles) {
  let tag = config.prerelease ? `${config.prerelease}` : "latest";

  try {
    for (let bundle of bundles) {
      if (bundle.prepublish) {
        core.info(`Running prepublish command: ${bundle.prepublish}...`);
        await spawnWithLogs(bundle.prepublish);
      }
      switch (bundle.type.toLowerCase()) {
        case "npm":
          core.info(`Publishing ${bundle.folder}...`);
          await spawnWithLogs(
            `npm publish ${bundle.folder} --access public --tag ${tag}`
          );
          break;
        default:
          core.warning(
            `Bundle type: ${bundle.type} is not currently supported`
          );
          break;
      }
    }
  } catch (err) {
    core.error(err.message);
  }
  return version;
}

async function push() {
  core.info("Pushing Changes...");
  await git.push("origin", branch);
  core.info("Pushing Tags...");
  await git.pushTags("origin");
}

async function changelog(version, file) {
  await spawnWithLogs(`npx standard-changelog -i ${file} -s`);
  return version;
}

const deployGithubPages = async (version, docs) => {
  const prepublish = Array.isArray(docs.prepublish)
    ? docs.prepublish
    : [docs.prepublish];
  const commands = prepublish
    .map((it) => {
      if (it && it.preset) {
        switch (it.preset) {
          case "angular":
            return `npx ng build ${it.app} --base-href /${pkg.name}/${docs.dest}/ --deploy-url /${pkg.name}/${docs.dest}/`;
          default:
            return false;
        }
      }
      return it;
    })
    .filter(Boolean);
  for (let command of commands) {
    core.info(`Running Prepublish command: ${command}`);
    await spawnWithLogs(command);
  }

  //git remote set-url origin https://git:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git
  await git.remote([
    "set-url",
    "origin",
    `https://git:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`,
  ]);

  return await new Promise((resolve, reject) => {
    const dest = docs.dest || ".";
    ghpages.publish(
      docs.dir,
      {
        dest,
        ...docs.options,
        remove: `${dest}/**/*`,
        message: "chore(release): v" + version,
        user: {
          name: "Bump And Release",
          email: core.getInput("git-user-email"),
        },
      },
      (err) => {
        if (err) {
          core.error("Error while publishing demo.");
          core.info(err);
          return reject(err);
        }
        core.info("Demo published!");
        resolve(version);
      }
    );
  });
};

async function run() {
  try {
    await initialize();
    core.info(`bump-and-release: ${pkg.name}`);
    core.info(`running on branch: ${branch}`);
    const config = await getBranchConfig(globalConfig);
    const { docs, skipChangeLog } = config;
    if (config) {
      const latest = await getLatestFromNPM();
      core.info(`Latest Version from NPM: ${latest.version}`);
      const releaseType = await getReleaseType(config, latest);
      core.info(`Determined Release Type: ${releaseType}`);
      const version = await recommendVersion(
        latest,
        releaseType,
        config.prerelease
      );
      core.info(`Next Version is: ${version}`);

      if (core.getBooleanInput("skip-bump")) {
        core.info(`Skipping Bump and Publish`);
        for (let bundle of globalConfig.bundles) {
          if (bundle.prepublish) {
            core.info(
              `Still running prepublish command: ${bundle.prepublish}...`
            );
            await spawnWithLogs(bundle.prepublish);
          }
        }
      } else {
        const changedFiles = await bump(version, globalConfig.bumpFiles);
        core.info(`Bumped Version in ${changedFiles.length} files`);
        if (!skipChangeLog) {
          const changelogFile = path.join(root, "CHANGELOG.md");
          await changelog(version, changelogFile);
          core.info(`Change Log Generated`);
          changedFiles.push(changelogFile);
        }

        await commitVersion(version, [...changedFiles]);
        core.info(`Generated Tag`);
        await publish(version, config, globalConfig.bundles);
        core.info(`Published Bundles`);
        await push();
      }

      if (core.getBooleanInput("skip-docs")) {
        core.info(`Skipping Deploy Docs/Demo`);
      } else if (docs) {
        switch (docs.type) {
          case "ghpages":
            await deployGithubPages(version, docs);
            core.info(`Github Pages Deployed`);
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

# Getting Started

This Action will version your project, publishes a package, and then deploys the documentation/demo to github pages. It is meant to be used on every successful merge to master or to any prerelease branch but you'll need to configure that build workflow yourself. You can look to the [`.github/workflows/test.yml`](./.github/workflows/test.yml) file in this project as an example.

### Workflow

* Check for the latest version number published to npm.
* Lookup all commits between the git commit that triggered the action and the latest publish.
  * If the package hasn't been published or the prior publish does not include a git hash, we'll
    only pull the commit data that triggered the action.
* Based on the commit messages, increment the version from the lastest release.
  * If the string "BREAKING CHANGE" is found anywhere in any of the commit messages or descriptions the major 
    version will be incremented.
  * If a commit message begins with the string "feat" then the minor version will be increased. This works
    for most common commit metadata for feature additions: `"feat: new API"` and `"feature: new API"`.
  * All other changes will increment the patch version.
* Publish to npm using the configured token.
* Push a tag for the new version to GitHub.
* Build demo site (optional)
* Deploy demo site (optional)

### Usage

```yaml
- uses: bvkimball/bump-and-release@master
  with:
    git-user-email: 'bvkimball@users.noreply.github.com'
  env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      NPM_AUTH_TOKEN: ${{ secrets.NPM_AUTH_TOKEN }}
```

### Configuration

The `bump-and-release` action require some environmental variables to be setup for your credentials..

* **GITHUB_TOKEN (required)**
  * Github token to allow tagging the version.
* **NPM_AUTH_TOKEN (required)**
  * NPM Auth Token to publish to NPM, read [here](https://docs.github.com/en/actions/configuring-and-managing-workflows/creating-and-storing-encrypted-secrets) how to setup it as a secret.

The rest of your configuration must be set in your `bump.json` file in the project root to configure how this action works.

```json
// bump.json
{
  // List all the branches this action should be invoked on
  "branches": [
    {
      "name": "master",
      // Branch specific documentation deploy options
      "docs": {
        // The destination to deploy the docs to (ghpages specific)
        "dest": "docs"
      }
    },
    {
      "name": "next",
      "prerelease": "rc",
      "skipChangeLog": true,
      "docs": {
        "dest": "next"
      }
    }
  ],
  // List all the branches this action should be invoked on
  "docs": {
    // Currently on ghpages is supported
    "type": "ghpages",
    // The directory to deploy
    "dir": "dist/demo",
    // Pre-build options (optional) will not build in omitted
    "build": {
      // Will build angular app with `ng build {app}`
      // will setup base-href
      "preset": "angular",
      "app": "demo"
    }
  },
  "bundles": [
    {
      "type": "npm",
      "folder": "dist/library"
    }
  ]
}
```

## Acknowlegements

Inspired by https://github.com/mikeal/merge-release and https://github.com/ng-lightning/ng-lightning/blob/master/scripts/release.js

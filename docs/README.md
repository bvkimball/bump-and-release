# Use branch name on GitHub actions

Convenience action for get current branch names as environment variables.

## Usage

```
name: build
on: push

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v1
    - run: npm ci
    - uses: bvkimball/branch-vars@1.0.1
    # Use branch name for whatever purpose
    - run: echo ${CURRENT_BRANCH}
```

## VARIABELS

|     Output     |   type   |          Example           |                           Description                            |
| :------------: | :------: | :------------------------: | :--------------------------------------------------------------: |
| CURRENT_BRANCH | `string` | `main` _OR_ `feature/test` | Always returns a valid branch name for a triggered workflow run. |
| TARGET_BRANCH  | `string` |           `main`           |               The target branch of a pull request                |
| SOURCE_BRANCH  | `string` |       `feature/test`       |               The source branch of a pull request                |
|   REF_BRANCH   | `string` |   `1/merge` _OR_ `main`    |            The branch that triggered the workflow run            |

## Acknowlegements

Inspired by https://github.com/nelonoel/branch-name and https://github.com/tj-actions/branch-names

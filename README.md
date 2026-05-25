# FlowFuse MQTT Nodes

A set of Node-RED nodes that work seamlessly with the FlowFuse MQTT Broker
running in the [FlowFuse platform](https://flowfuse.com).

These nodes act in a similar way to the core Node-RED MQTT nodes without any
broker configuration required to get up and running.

Whilst these nodes are published under the Apache-2.0 license, they can only be
used with an instance of the FlowFuse platform with an active EE license applied.
If you try to install these nodes in an Non FlowFuse EE platform you will see the following error in your Node-RED log:
`Error: Project Link nodes cannot be loaded outside of FlowFuse EE environment`
This can be safely ignored.

### Prerequisites

 - FlowFuse 2.21.0 running with an active EE license and its integrated MQTT Broker

Alternatively, you can [sign up to FlowFuse Cloud](https://flowfuse.com/product/)
now to try these nodes out.

### Nodes

There are three nodes in this collection:

 - `FF MQTT In` - subscribes to topics on the FlowFuse MQTT Broker
 - `FF MQTT Out` - publishes messages to the FlowFuse MQTT Broker

For further usage details, please refer to the individual node's built-in documentation.

## Release process

In this project, the [Release Please](https://github.com/googleapis/release-please) is used to automatically determine the next release version based on the commit messages in the codebase. 

By using the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), the project adheres to a standardized format for commit messages, which `Release Please` uses to determine whether the next release should be a major, minor, or patch release.

### Components

1. The `Prepare release` GitHub Action workflow:

    * A Release Please action that analyzes commit messages to determine the type of release required (major, minor, patch) based on the Conventional Commits specification
    * Creates a pre-release pull request with the proposed version bump and changelog
    * Once merged, automatically updates the version number in `package.json` and creates a new release on GitHub with the appropriate changelog

2. The `Lint Pull Request Title` GitHub Action workflow:

    * A workflow that runs on pull request creation and uses the `amannn/action-semantic-pull-request` action to validate that pull request titles follow the Conventional Commits format
    * Together with adjusted default merge commit message, this ensures that all commits merged into the main branch adhere to the expected format, allowing Release Please to function correctly


### Pull Request Title Format

The Conventional Commits preset expects pull request titles to be in the following format:

```
<type>(<scope>): <subject>
```

* Type: Describes the category of the commit. Examples include:
    * `feat`: A new feature (triggers a minor version bump).
    * `fix`: A bug fix (triggers a patch version bump).
    * `perf`: A code change that improves performance (triggers a patch version bump).
    * `refactor`: A code change that neither fixes a bug nor adds a feature (does not trigger a release unless it's accompanied by a BREAKING CHANGE).
    * `docs`: Documentation-only changes (does not trigger a release).
    * `chore`: Changes to the build process or auxiliary tools and libraries (does not trigger a release).
* Scope: An optional part that provides additional context about what was changed (e.g., module, component).
* Subject: A brief description of the changes.

### Handling Breaking Changes

To indicate a breaking change, the exclamation mark `!` should be used immediately after the type/scope:

* `feat!:,` 
* `fix!:`
* `refactor!:`

#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { SpecParser } from "~/parse/spec-parser";
import { JsGenerator } from "~/write/js-generator";
import { CLI_HELP_MSG, CLI_POST_COMMUNITY_REPO_GENERATION_MSG } from "~/constants";
import { JsonGenerator } from "./write/json-generator";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execCb);

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args.includes("--help") || args.includes("-h")) {
    console.log(CLI_HELP_MSG);
    process.exit(0);
  }

  const specPath = args[0];

  const customServiceName = getOption(args, "--service-name");
  const pretty = getOption(args, "--skip-formatting") ? false : true;
  const outputDir = getOption(args, "--output-dir") || "./nodewriter-output";
  const communityNodeRepo = getOption(args, "--community-node-repo");
  const experimentalJson = getOption(args, "--experimental-json") || communityNodeRepo;

  try {
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`Parsing OpenAPI spec: ${specPath}`);
    const extract = await new SpecParser().parse(specPath);

    console.log("Generating...");
    const generator = experimentalJson ? new JsonGenerator({ pretty }) : new JsGenerator({ pretty });

    const result = await generator.run(extract, customServiceName ?? extract.descriptors.nodeTypeClassName);

    if (communityNodeRepo) {
      await fs.mkdir(`${outputDir}/${communityNodeRepo}`, { recursive: true });
      await exec(`git clone https://github.com/n8n-io/n8n-nodes-starter.git .`, {
        cwd: `${outputDir}/${communityNodeRepo}`,
      });

      const packageJson = await fs.readFile(`${outputDir}/${communityNodeRepo}/package.json`, "utf-8");
      const packageJsonObj = JSON.parse(packageJson);

      packageJsonObj.name = communityNodeRepo;
      packageJsonObj.n8n = {
        n8nNodesApiVersion: 1,
        credentials: [],
        nodes: [],
      };

      try {
        const { stdout: name } = await exec(`git config user.name`);
        const { stdout: email } = await exec(`git config user.email`);

        packageJsonObj.author = { name: name.replace("\n", ""), email: email.replace("\n", "") };
      } catch (e) {
        console.log(e);
      }

      await exec(`rm -rf ./${communityNodeRepo}/nodes/*`, { cwd: outputDir });

      if (!result.credTypes.length) {
        await exec(`rm -rf ./${communityNodeRepo}/credentials`, { cwd: outputDir });
      } else {
        await exec(`rm -rf ./${communityNodeRepo}/credentials/*`, { cwd: outputDir });
      }

      const className = result.nodeType.fileName.split(".")[0];
      const nodeDir = path.join(`${outputDir}/${communityNodeRepo}/nodes/${className}`);
      await fs.mkdir(nodeDir, { recursive: true });
      const nodeTypePath = path.join(
        `${outputDir}/${communityNodeRepo}/nodes/${className}`,
        result.nodeType.fileName.replace(".json", ".ts"),
      );

      result.nodeType.source = result.nodeType.source.replace(
        '"inputs": ["main"],',
        "inputs: [NodeConnectionType.Main],",
      );
      result.nodeType.source = result.nodeType.source.replace(
        '"outputs": ["main"],',
        "outputs: [NodeConnectionType.Main],",
      );
      let source = `
			import { INodeType, INodeTypeDescription, NodeConnectionType } from 'n8n-workflow';

			export class ${className} implements INodeType {
				description: INodeTypeDescription = ${result.nodeType.source};
			}`;

      const { Formatter } = await import("~/write/formatter");
      const formatter = new Formatter();

      source = await formatter.format(source, "ts");

      await fs.writeFile(nodeTypePath, source);

      packageJsonObj.n8n.nodes.push(`dist/nodes/${className}/${result.nodeType.fileName.replace(".json", ".js")}`);

      for (const credType of result.credTypes) {
        const credClassName = credType.fileName.split(".")[0];
        const credTypePath = path.join(
          `${outputDir}/${communityNodeRepo}/credentials`,
          credType.fileName.replace(".json", ".ts"),
        );
        const credJson = JSON.parse(credType.source);
        let source = `
				import {
					ICredentialType,
					INodeProperties,
					${credJson.authenticate ? `IAuthenticateGeneric,` : ""}
				} from 'n8n-workflow';

				export class ${credClassName} implements ICredentialType {
					name = "${credJson.name}";
					displayName = "${credJson.displayName}";
					documentationUrl = "${credJson.documentationUrl}";
					properties: INodeProperties[] = ${JSON.stringify(credJson.properties)};

					${credJson.authenticate ? `authenticate: IAuthenticateGeneric = ${JSON.stringify(credJson.authenticate)};` : ""}
				}`;

        source = await formatter.format(source, "ts");
        await fs.writeFile(credTypePath, source);

        packageJsonObj.n8n.credentials.push(`dist/credentials/${credType.fileName.replace(".json", ".js")}`);
      }

      const updatedPackageJson = await formatter.format(JSON.stringify(packageJsonObj), "json");
      await fs.writeFile(`${outputDir}/${communityNodeRepo}/package.json`, updatedPackageJson);
      console.log(CLI_POST_COMMUNITY_REPO_GENERATION_MSG);
      return;
    }

    const nodeTypePath = path.join(outputDir, result.nodeType.fileName);
    await fs.writeFile(nodeTypePath, result.nodeType.source);
    console.log(`Node type written to: ${nodeTypePath}`);

    for (const credType of result.credTypes) {
      const credTypePath = path.join(outputDir, credType.fileName);
      await fs.writeFile(credTypePath, credType.source);
      console.log(`Credential type written to: ${credTypePath}`);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

function getOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return;
  return args[index + 1];
}

main();

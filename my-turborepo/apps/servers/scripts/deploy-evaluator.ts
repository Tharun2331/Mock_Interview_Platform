// Builds the Evaluator image, pushes it to ECR and points the Lambda at it.
//
//   bun run deploy:evaluator          # dev
//   bun run deploy:evaluator prod
//
// The repository and function names come from that environment's Terraform
// outputs, never typed in. Needs Docker running, `terraform` and the AWS CLI on
// PATH, and credentials that can push to ECR and update the function (set
// AWS_PROFILE if they are not your default profile).
//
// Before the function exists (its first rollout — see modules/evaluator) this
// only pushes, which is the image the function is then created from.
import { $ } from "bun";
import path from "node:path";

const environment = process.argv[2] ?? "dev";
const serversDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(serversDir, "../..");
const terraformDir = path.join(repoRoot, `infra/terraform/environments/${environment}`);

type TerraformOutputs = Record<string, { value: unknown }>;
const outputs = (await $`terraform -chdir=${terraformDir} output -json`
  .quiet()
  .json()) as TerraformOutputs;

const repositoryUrl = outputs.evaluator_repository_url?.value;
if (typeof repositoryUrl !== "string" || repositoryUrl.length === 0) {
  throw new Error(
    `No evaluator_repository_url in ${environment}'s Terraform outputs. Create the repository first: ` +
      "terraform apply -target=module.evaluator.aws_ecr_repository.evaluator",
  );
}
// Absent until the function's first apply — then this run only pushes.
const functionName = outputs.evaluator_function_name?.value;

// 123456789012.dkr.ecr.us-east-1.amazonaws.com/prepilot-evaluator-dev
const [registry = "", repositoryName = ""] = repositoryUrl.split("/");
const region = registry.split(".")[3] ?? "us-east-1";

// The commit, so an image in ECR traces back to its source. Marked when the
// working tree has uncommitted changes, because then the commit alone does not
// describe what was built.
const commit = (await $`git rev-parse --short HEAD`.cwd(repoRoot).text()).trim();
const dirty = (await $`git status --porcelain`.cwd(repoRoot).text()).trim().length > 0;
const tag = dirty ? `${commit}-dirty` : commit;

// Fail early and plainly if Docker Desktop is not running, rather than in the
// middle of a login pipe.
if ((await $`docker info`.quiet().nothrow()).exitCode !== 0) {
  throw new Error("Docker is not running. Start Docker Desktop and try again.");
}

await $`aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`;

// --provenance/--sbom off: buildx otherwise wraps the image in an OCI index of
// attestations, and Lambda rejects any image manifest that is an index.
await $`docker build --platform linux/arm64 --provenance=false --sbom=false -f apps/servers/evaluator.Dockerfile -t ${repositoryUrl}:${tag} -t ${repositoryUrl}:latest .`.cwd(
  repoRoot,
);
await $`docker push ${repositoryUrl}:${tag}`;
await $`docker push ${repositoryUrl}:latest`;

if (typeof functionName !== "string" || functionName.length === 0) {
  console.log(
    `\nPushed ${tag}. The function does not exist yet — run terraform apply to create it from this image.`,
  );
  process.exit(0);
}

// By digest, not tag: the function runs exactly the image just built, and a
// later re-tag of :latest cannot change what it runs.
const digest = (
  await $`aws ecr describe-images --region ${region} --repository-name ${repositoryName} --image-ids imageTag=${tag} --query imageDetails[0].imageDigest --output text`.text()
).trim();

await $`aws lambda update-function-code --region ${region} --function-name ${functionName} --image-uri ${repositoryUrl}@${digest} --query LastUpdateStatus --output text`;
await $`aws lambda wait function-updated-v2 --region ${region} --function-name ${functionName}`;

console.log(`\nDeployed ${tag} (${digest}) to ${functionName}.`);

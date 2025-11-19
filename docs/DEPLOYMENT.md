# Deployment Guide

This document explains how to run the Zuvy Eval server locally with Docker and how to ship the same container image to an EC2 instance using Amazon Elastic Container Registry (ECR).

## 1. Prerequisites

- Docker Engine **24+** and Docker Compose V2.
- AWS CLI v2 configured with credentials that can manage ECR and EC2.
- An AWS account with permissions to create repositories, launch EC2 instances, and manage IAM roles.

## 2. Environment variables & secrets

1. Copy the example file and fill in values that are appropriate for the deployment target:

   ```bash
   cp .env.docker.example .env.docker      # local / CI
   cp .env.docker.example .env.ec2         # production (kept outside git by .gitignore)
   ```

2. Never commit any file that contains real secrets.
3. For EC2, consider storing sensitive values in AWS SSM Parameter Store or Secrets Manager and load them into the container with your orchestration tooling.

## 3. Build & run locally

```bash
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
docker compose logs -f api
```

To spin up a disposable Postgres database alongside the API, layer in the local override file:

```bash
docker compose --env-file .env.docker \
  -f docker-compose.yml \
  -f docker-compose.local.yml \
  up -d
```

This override starts a `postgres:16-alpine` container, persists data inside the `postgres-data` volume, and points the API at the in-network database (`DB_HOST=postgres`). Update `.env.docker` to use the same credentials that are declared in `docker-compose.local.yml`.

Stop and clean up:

```bash
docker compose down        # keeps volumes
docker compose down -v     # removes the postgres-data volume as well
```

## 4. Build & push an image to ECR

```bash
AWS_REGION=ap-south-1
AWS_ACCOUNT_ID=<account-id>
ECR_REPOSITORY=zuvy-eval-server
IMAGE_TAG=$(git rev-parse --short HEAD)

aws ecr describe-repositories --repository-name $ECR_REPOSITORY \
  || aws ecr create-repository --repository-name $ECR_REPOSITORY

aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

docker build --platform linux/amd64 -t ${ECR_REPOSITORY}:${IMAGE_TAG} .
docker tag ${ECR_REPOSITORY}:${IMAGE_TAG} ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}
docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}
```

## 5. Deploy on an EC2 instance

1. Launch an Amazon Linux 2023 (or Ubuntu 22.04 LTS) instance with security groups that allow inbound traffic on the port you expose (5000 by default) or attach it to an internal load balancer.
2. Install Docker & Compose:

   ```bash
   sudo amazon-linux-extras install docker -y   # or follow distro-specific instructions
   sudo service docker start
   sudo usermod -aG docker ec2-user
   DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}
   sudo curl -SL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
     -o /usr/local/bin/docker-compose
   sudo chmod +x /usr/local/bin/docker-compose
   ```

3. Copy `docker-compose.yml` and your `.env.ec2` file to the server (rsync/scp/S3). The env file should contain production RDS/S3/API keys and a `BASE_URL` that matches the domain or load balancer URL.
4. Pull the image you pushed to ECR:

   ```bash
   aws ecr get-login-password --region $AWS_REGION \
     | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

   DOCKER_IMAGE=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}
   DOCKER_TAG=${IMAGE_TAG:-latest}
   docker compose --env-file .env.ec2 pull
   ```

5. Start the stack:

   ```bash
   docker compose --env-file .env.ec2 up -d
   docker compose --env-file .env.ec2 ps
   ```

   Compose automatically restarts the container if it crashes. For extra resilience you can wrap the compose command inside a `systemd` unit or run it under AWS ECS on EC2.

6. Point your ALB / NLB / security group at port 5000 (or whichever `PORT` you configured) and verify the health of `/api` or the root endpoint.

## 6. Operational tips

- Inspect logs with `docker compose logs -f api`.
- Rebuild after code changes: `docker compose build --no-cache`.
- Rotate secrets by updating the env file and running `docker compose up -d` to recreate the container.
- Back up the `postgres-data` volume only when you run the local Postgres container; production should continue to use the managed RDS instance defined in the env file.

# AWS ECS on Fargate with RDS

Riosoma runs as one Fargate task behind an Application Load Balancer, and its database is an Amazon RDS for PostgreSQL instance that only the task can reach.  Secrets live in AWS Secrets Manager.

This guide uses the account's default VPC to stay short: the load balancer and task in its public subnets, the task with a public address so it can pull the image, and security groups that let only the load balancer reach the task and only the task reach the database.  In your own VPC, run the task in private subnets with a NAT gateway instead.

## Prerequisites

- An AWS account, and the AWS CLI v2 signed in to it with rights to create the resources below
- An AWS Certificate Manager certificate for your domain, such as `riosoma.example.com`, issued in the same region
- `jq` and `openssl`
- The commands are for bash

## Install

```bash
export AWS_REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
IMAGE=ghcr.io/adachis/riosoma:0.95.0-rc.1
CONNECTORS_IMAGE=ghcr.io/adachis/riosoma-connectors:0.95.0-rc.1
DOMAIN=riosoma.example.com
CERT_ARN=arn:aws:acm:us-east-1:111122223333:certificate/your-certificate-id
```

**The network.**  Three security groups, for the load balancer, the task, and the database:

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text)
SUBNET_LIST=$(echo $SUBNETS | tr ' ' ',')
ALB_SG=$(aws ec2 create-security-group --group-name riosoma-alb --description 'Riosoma load balancer' \
  --vpc-id $VPC --query GroupId --output text)
APP_SG=$(aws ec2 create-security-group --group-name riosoma-app --description 'Riosoma task' \
  --vpc-id $VPC --query GroupId --output text)
DB_SG=$(aws ec2 create-security-group --group-name riosoma-db --description 'Riosoma database' \
  --vpc-id $VPC --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $ALB_SG --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $APP_SG --protocol tcp --port 8080 --source-group $ALB_SG
aws ec2 authorize-security-group-ingress --group-id $DB_SG --protocol tcp --port 5432 --source-group $APP_SG
```

**The database.**  Encrypted, private, and backed up daily for 14 days:

```bash
DB_PASSWORD=$(openssl rand -hex 24)
aws rds create-db-instance --db-instance-identifier riosoma --engine postgres \
  --db-instance-class db.t4g.small --allocated-storage 20 --storage-type gp3 --storage-encrypted \
  --master-username riosoma --master-user-password "$DB_PASSWORD" --db-name riosoma \
  --vpc-security-group-ids $DB_SG --no-publicly-accessible --backup-retention-period 14
aws rds wait db-instance-available --db-instance-identifier riosoma
DB_HOST=$(aws rds describe-db-instances --db-instance-identifier riosoma \
  --query 'DBInstances[0].Endpoint.Address' --output text)
```

RDS signs its certificates with its own authority, so give Riosoma the region's bundle in a database profile, which lets it verify the server fully:

```bash
curl -fsSLo rds-ca.pem https://truststore.pki.rds.amazonaws.com/$AWS_REGION/$AWS_REGION-bundle.pem
jq -n --arg host "$DB_HOST" --arg password "$DB_PASSWORD" --rawfile ca rds-ca.pem '{
  host: $host, database: "riosoma", user: "riosoma",
  auth: {method: "password", password: $password},
  tls: {mode: "verify-full", caPem: $ca}
}' > profile.json
```

**The secrets.**  Keep a copy of the secret key outside AWS too.  It seals the credentials Riosoma stores, and a restore needs it.

```bash
KEY_ARN=$(aws secretsmanager create-secret --name riosoma/secret-key \
  --secret-string "$(openssl rand -base64 32)" --query ARN --output text)
PROFILE_ARN=$(aws secretsmanager create-secret --name riosoma/database-profile \
  --secret-string file://profile.json --query ARN --output text)
rm profile.json
TOKEN_ARN=$(aws secretsmanager create-secret --name riosoma/connector-service-token \
  --secret-string "$(openssl rand -hex 32)" --query ARN --output text)
```

The third secret is the token Riosoma shares with its connector service, which runs beside it in the same task.

**The roles.**  ECS uses the execution role to pull the images, write logs, and read the three secrets:

```bash
aws iam create-role --role-name riosoma-task-execution --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name riosoma-task-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name riosoma-task-execution --policy-name riosoma-secrets --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":[\"$KEY_ARN\",\"$PROFILE_ARN\",\"$TOKEN_ARN\"]}]}"
```

**The load balancer.**  HTTPS with your certificate, HTTP redirected to it, and a target group that checks `/healthz`:

```bash
ALB_ARN=$(aws elbv2 create-load-balancer --name riosoma --subnets $SUBNETS --security-groups $ALB_SG \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
TG_ARN=$(aws elbv2 create-target-group --name riosoma --protocol HTTP --port 8080 --vpc-id $VPC \
  --target-type ip --health-check-path /healthz --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 create-listener --load-balancer-arn $ALB_ARN --protocol HTTPS --port 443 \
  --certificates CertificateArn=$CERT_ARN --default-actions Type=forward,TargetGroupArn=$TG_ARN
aws elbv2 create-listener --load-balancer-arn $ALB_ARN --protocol HTTP --port 80 \
  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN --query 'LoadBalancers[0].DNSName' --output text
```

Point a CNAME (or a Route 53 alias) for your domain at the name the last command prints.

**The task definition.**  Riosoma and its connector service, which runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources, share the task, so Riosoma reaches the service on the task's own loopback address, where nothing outside the task can.  The images have no shell, so the container health checks run Node themselves:

```bash
aws logs create-log-group --log-group-name /ecs/riosoma
cat > task-definition.json <<EOF
{
  "family": "riosoma",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "1024",
  "memory": "2048",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::$ACCOUNT:role/riosoma-task-execution",
  "containerDefinitions": [
    {
      "name": "riosoma",
      "image": "$IMAGE",
      "essential": true,
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "environment": [
        { "name": "RIOSOMA_BASE_URL", "value": "https://$DOMAIN" },
        { "name": "RIOSOMA_TRUST_PROXY", "value": "1" },
        { "name": "RIOSOMA_CONNECTOR_SERVICE_URL", "value": "http://127.0.0.1:8091" }
      ],
      "secrets": [
        { "name": "RIOSOMA_SECRET_KEY", "valueFrom": "$KEY_ARN" },
        { "name": "RIOSOMA_DATABASE_PROFILE", "valueFrom": "$PROFILE_ARN" },
        { "name": "RIOSOMA_CONNECTOR_SERVICE_TOKEN", "valueFrom": "$TOKEN_ARN" }
      ],
      "healthCheck": {
        "command": ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"],
        "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 300
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/riosoma", "awslogs-region": "$AWS_REGION", "awslogs-stream-prefix": "riosoma" }
      }
    },
    {
      "name": "connectors",
      "image": "$CONNECTORS_IMAGE",
      "essential": true,
      "environment": [{ "name": "RIOSOMA_CONNECTOR_SERVICE_HOST", "value": "127.0.0.1" }],
      "secrets": [{ "name": "RIOSOMA_CONNECTOR_SERVICE_TOKEN", "valueFrom": "$TOKEN_ARN" }],
      "healthCheck": {
        "command": ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8091/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"],
        "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/riosoma", "awslogs-region": "$AWS_REGION", "awslogs-stream-prefix": "connectors" }
      }
    }
  ]
}
EOF
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

**The service.**  One task, always running, since automations, webhooks, scheduled reports, and syncs run inside the server.  A minimum healthy percent of 0 stops the old task before a new one starts, so two releases never share the database.

```bash
aws ecs create-cluster --cluster-name riosoma
aws ecs create-service --cluster riosoma --service-name riosoma --task-definition riosoma \
  --desired-count 1 --launch-type FARGATE \
  --deployment-configuration 'maximumPercent=100,minimumHealthyPercent=0' \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_LIST],securityGroups=[$APP_SG],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=riosoma,containerPort=8080" \
  --health-check-grace-period-seconds 300
aws ecs wait services-stable --cluster riosoma --services riosoma
```

## First-run setup

```bash
aws logs filter-log-events --log-group-name /ecs/riosoma --filter-pattern '"Finish setting up"' \
  --query 'events[-1].message' --output text
```

Open the link and create the owner account.  The task's file system doesn't outlast it, so each new task makes a new setup token, and the newest link is the one that works.  Check where setup stands at `https://riosoma.example.com/api/setup/status`.

## Where settings go

- Settings that aren't secret: `environment` in `task-definition.json`.
- Secret settings: a Secrets Manager secret, named under `secrets` in the task definition, and added to the execution role's policy.

After a change, register the task definition again and roll the service onto it:

```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
aws ecs update-service --cluster riosoma --service riosoma --task-definition riosoma
```

Every setting is in the [settings reference](settings.md).  Required here: `RIOSOMA_DATABASE_PROFILE` (or `RIOSOMA_DATABASE_URL`), `RIOSOMA_SECRET_KEY`, `RIOSOMA_BASE_URL`, and `RIOSOMA_TRUST_PROXY`.  The task's `/config` isn't persistent, which is fine once those are set: it then holds only the setup token.  To use email, add `RIOSOMA_SMTP_URL` as a secret and `RIOSOMA_MAIL_FROM` to `environment`.  On AWS, `RIOSOMA_MAIL_TRANSPORT=ses` with `RIOSOMA_SES_REGION` and the task's own role needs no secret at all.  See [Email](email.md).

To sign in to the database with IAM instead of a password, add a task role and see [Connecting the database](database.md#amazon-rds-with-iam).

## Backups

RDS takes a snapshot daily and keeps 14 days of point-in-time restore, as created above.  Riosoma keeps attachments in the database by default, so that covers them.  Keep the secret key with your records.

## Upgrades

Snapshot the database, then move the service to a task definition with the new image.  Migrations run when the new task starts.  See [Upgrades, backups, and rollbacks](upgrades.md).

```bash
aws rds create-db-snapshot --db-instance-identifier riosoma --db-snapshot-identifier riosoma-before-0-6-0
aws rds wait db-snapshot-available --db-snapshot-identifier riosoma-before-0-6-0
sed -i.bak -e 's|ghcr.io/adachis/riosoma-connectors:[^"]*|ghcr.io/adachis/riosoma-connectors:0.95.0-rc.1|' \
  -e 's|ghcr.io/adachis/riosoma:[^"]*|ghcr.io/adachis/riosoma:0.95.0-rc.1|' task-definition.json
aws ecs register-task-definition --cli-input-json file://task-definition.json
aws ecs update-service --cluster riosoma --service riosoma --task-definition riosoma
aws ecs wait services-stable --cluster riosoma --services riosoma
aws logs filter-log-events --log-group-name /ecs/riosoma --filter-pattern '"migrations applied"' \
  --query 'events[-1].message' --output text
```

**Rolling back:** every registration is a new revision, so point the service at the previous one, which `aws ecs list-task-definitions --family-prefix riosoma` lists:

```bash
aws ecs update-service --cluster riosoma --service riosoma --task-definition riosoma:3
```

If the upgrade applied migrations, stop the service first (`--desired-count 0`), restore the snapshot to a new instance, point the profile at it, then start the previous revision:

```bash
aws ecs update-service --cluster riosoma --service riosoma --desired-count 0
aws rds restore-db-instance-from-db-snapshot --db-instance-identifier riosoma-restored \
  --db-snapshot-identifier riosoma-before-0-6-0 --db-instance-class db.t4g.small \
  --vpc-security-group-ids $DB_SG --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier riosoma-restored
# Rebuild profile.json with the new host, then:
aws secretsmanager put-secret-value --secret-id riosoma/database-profile --secret-string file://profile.json
aws ecs update-service --cluster riosoma --service riosoma --task-definition riosoma:3 --desired-count 1
```

## Removing it

Delete the service, cluster, load balancer, target group, database (with or without a final snapshot), secrets, log group, role, and security groups, in that order.

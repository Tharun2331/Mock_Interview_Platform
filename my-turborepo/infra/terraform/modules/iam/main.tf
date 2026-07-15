locals {
  bedrock_model_arns = [
    for id in var.bedrock_model_ids :
    "arn:aws:bedrock:${var.aws_region}::foundation-model/${id}"
  ]
}

resource "aws_iam_policy" "bedrock_invoke" {
  name        = "prepilot-bedrock-invoke-${var.environment}"
  description = "Allow PrepPilot server to invoke Bedrock models (${var.environment})"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BedrockInvoke"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = local.bedrock_model_arns
      }
    ]
  })
}

resource "aws_iam_role" "server" {
  name = "prepilot-server-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ecs-tasks.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Project     = "prepilot"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "server_bedrock" {
  role       = aws_iam_role.server.name
  policy_arn = aws_iam_policy.bedrock_invoke.arn
}

resource "aws_iam_policy" "dynamodb_access" {
  count       = length(var.dynamodb_table_arns) > 0 ? 1 : 0
  name        = "prepilot-dynamodb-access-${var.environment}"
  description = "Allow PrepPilot server to read/write DynamoDB tables (${var.environment})"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = concat(
          var.dynamodb_table_arns,
          [for arn in var.dynamodb_table_arns : "${arn}/index/*"]
        )
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "server_dynamodb" {
  count      = length(var.dynamodb_table_arns) > 0 ? 1 : 0
  role       = aws_iam_role.server.name
  policy_arn = aws_iam_policy.dynamodb_access[0].arn
}


#!/bin/bash
# Deploy Lambda function to AWS
# Usage: ./scripts/deploy.sh
# Requires: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in environment

set -e

FUNCTION_NAME="house-v2-api"
REGION="us-east-1"
ROLE_ARN="arn:aws:iam::014810124016:role/house-v2-app-role"
RUNTIME="nodejs22.x"
HANDLER="index.handler"
ZIP_FILE="/tmp/house-v2-lambda.zip"

# Validate required env vars
for var in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  if [ -z "${!var}" ]; then
    echo "ERROR: $var is not set"
    exit 1
  fi
done

echo "==> Installing Lambda dependencies..."
cd "$(dirname "$0")/.."
cp package-lock.json lambda/
cd lambda
npm install --omit=dev --prefix .
cd ..

echo "==> Zipping deployment package..."
cd lambda
zip -r "$ZIP_FILE" . \
  --exclude "*.test.js" \
  --exclude "node_modules/.cache/*" \
  --exclude ".git/*"
cd ..

echo "==> Deploying to AWS Lambda..."

# Check if function exists
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" > /dev/null 2>&1; then
  echo "    Updating existing function..."
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$REGION" \
    --output json | jq '.FunctionName, .LastModified'

  # Wait for update to complete
  aws lambda wait function-updated \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION"

  # Update environment variables
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --environment "Variables={
      SUPABASE_URL=$SUPABASE_URL,
      SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
    }" \
    --output json | jq '.FunctionName'

else
  echo "    Creating new function..."
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" \
    --role "$ROLE_ARN" \
    --handler "$HANDLER" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$REGION" \
    --timeout 60 \
    --memory-size 512 \
    --environment "Variables={
      SUPABASE_URL=$SUPABASE_URL,
      SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
    }" \
    --output json | jq '.FunctionName, .FunctionArn'
fi

echo "==> Done! Lambda deployed: $FUNCTION_NAME"
rm -f "$ZIP_FILE"

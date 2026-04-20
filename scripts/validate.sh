#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Checking browser app syntax..."
node --check assets/app.js

echo "Checking Supabase Edge Functions..."
deno check supabase/functions/**/*.ts

echo "Running Supabase function tests..."
deno test supabase/functions/**/*.test.ts

echo "Checking staged/working-tree whitespace..."
git diff --check

echo "Validation complete."

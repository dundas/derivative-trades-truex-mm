#!/bin/bash

# TrueX FIX Protocol Test Runner
# Runs all test suites for the TrueX market maker implementation

echo "🧪 TrueX FIX Protocol Test Suite"
echo "================================="
echo ""

# Check if Jest is installed
if ! command -v npx &> /dev/null; then
    echo "❌ npx not found. Please install Node.js and npm."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing test dependencies..."
    npm install
    echo ""
fi

# Run all tests
echo "🚀 Running all test suites..."
echo ""

# Run FIX message builder tests
echo "1️⃣ FIX Message Builder Tests"
echo "----------------------------"
npx jest fix-message-builder.test.js --verbose
echo ""

# Run authentication flow tests
echo "2️⃣ Authentication Flow Tests"
echo "----------------------------"
npx jest auth-flow.test.js --verbose
echo ""

# Run error handling tests
echo "3️⃣ Error Handling Tests"
echo "-----------------------"
npx jest error-handling.test.js --verbose
echo ""

# Run all tests with coverage
echo "📊 Running coverage report..."
echo "-----------------------------"
npx jest --coverage --silent
echo ""

echo "✅ All tests completed!"
echo ""
echo "📋 Test Summary:"
echo "  - FIX Message Builder: Unit tests for message construction and parsing"
echo "  - Authentication Flow: Integration tests for TrueX authentication"
echo "  - Error Handling: Tests for reject messages and error scenarios"
echo ""
echo "📁 Coverage report generated in: coverage/"
echo "🌐 Open coverage/lcov-report/index.html to view detailed coverage"




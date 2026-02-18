// Simple test to check the code
const fs = require('fs');
const code = fs.readFileSync('src/index.ts', 'utf8');

// Check for openhandsData
if (code.includes('openhandsData')) {
  console.log('ERROR: openhandsData found in code');
  console.log('Lines containing openhandsData:');
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('openhandsData')) {
      console.log(`${i+1}: ${line}`);
    }
  });
} else {
  console.log('OK: openhandsData not found in code');
}

// Check for openhandsResponse
if (code.includes('openhandsResponse')) {
  console.log('OK: openhandsResponse found in code');
} else {
  console.log('ERROR: openhandsResponse not found in code');
}

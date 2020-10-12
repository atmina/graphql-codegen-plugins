const tester = require('@atmina/codegen-tester');
tester('only-enum-types', {
  'documents/__generated__/types.ts': {
    plugins: ['./lib/index.js'],
  }
}).catch(console.error);

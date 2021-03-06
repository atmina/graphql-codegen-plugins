const tester = require('@atmina/codegen-tester');
tester('typescript-graphql-codegen', {
  'documents/': {
    preset: 'near-operation-file',
    presetConfig: {
      extension: '.generated.ts',
      baseTypesPath: '/__generated__/types.ts',
    },
    config: {"inlineFragmentTypes": "combine"},
    plugins: ['./lib/index.js'],
  }
}).catch(console.error);

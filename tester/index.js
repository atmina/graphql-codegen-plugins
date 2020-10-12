const { describe, it } = require('@jest/globals');
const { generate } = require('@graphql-codegen/cli');
const {join, basename} = require('path');

const tester = async (pluginName, generatorConfig) => {
  describe('The plugin ' + pluginName, () => {
    it('should generate code that matches the snapshots', async () => {
      const files = await generate({
        schema: join(__dirname, 'schema.graphql'),
        documents: join(__dirname, 'documents/**/*.graphql'),
        generates: generatorConfig,
      }, false);

      for (const file of files) {
        const filename = basename(file.filename);
        expect(file.content).toMatchSnapshot(filename);
      }
    });
  });
};

module.exports = tester;

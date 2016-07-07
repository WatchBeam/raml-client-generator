import { Target } from "./target";
import { Todo } from "./todo";
import { loadApi, api10 } from "raml-1-parser";

import * as path from "path";
import * as fs from "fs";

const pkg = require('../package.json');
const argv = require('yargs')
    .usage('$0 <raml path> -t [target] -o [output]')
    .version(pkg.version)
    .string('target').alias('t', 'target')
    .boolean('watch').alias('w', 'watch')
    .string('output').alias('o', 'output')
    .demand(1, ['target', 'output'])
    .describe({
        target: 'a target language to generate',
        watch: 'whether to watch the RAML files for changes',
        output: 'target directory to output'
    })
    .example('$0 ./docs/index.raml -t go -o ./dist')
    .help('help')
    .argv;

try {
    require.resolve(`./targets/${argv.target}`);
} catch (e) {
    console.error(`Invalid target "${argv.target}"`);
    process.exit(1);
}

const target = <Target>require(`./targets/${argv.target}`).default;
const todo = new Todo();

todo.start("Installing dependencies");
target.check()
.then(() => todo.start("Parsing RAML"))
.then(() => loadApi(argv._[0]))
.then((api: any) => {
    todo.finish();
    return target.generate(api, argv.output);
})
.then(() => process.exit(0))
.catch(e => {
    console.error(e.stack || e);
    process.exit(1);
});
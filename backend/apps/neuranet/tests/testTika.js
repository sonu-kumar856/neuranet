/**
 * Tests the Apache Tika based text extractor.
 * 
 * (C) 2023 Tekmonks. All rights reserved.
 */

const path = require("path");
const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;
const tika = require(`${NEURANET_CONSTANTS.PLUGINSDIR}/tika/tika.js`);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "extracttext")) {
        LOG.console(`Skipping extract text test case, not called.\n`)
        return;
    }
    if (!argv[1]) {LOG.console("Missing test file path.\n"); return;} 
    const pathToFile = path.resolve(argv[1]);

    const result = await tika.getContent(pathToFile);  // test text extraction using the Tika plugin
    if (!result) return false;

    const output = `Extracted text follows\n\n\n--------\n${result}\n--------\n\n\n`; LOG.info(output); LOG.console(output);
    return true;
}
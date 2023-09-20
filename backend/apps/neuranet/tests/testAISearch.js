/**
 * Tests overall AI search using AI DBs and algorithms inside them.
 * 
 * (C) 2023 Tekmonks. All rights reserved.
 */

const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;
const enterpriseassistant = require(`${NEURANET_CONSTANTS.APIDIR}/enterpriseassistant.js`);

const TEST_ID = "test@tekmonks.com", TEST_ORG = "Tekmonks", SEARCH_MODEL_DEFAULT = "chat-knowledgebase-gpt35-turbo";

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "aisearch")) {
        LOG.console(`Skipping TF.IDF DB test case, not called.\n`)
        return;
    }
    if (!argv[1]) {LOG.console("Missing search query.\n"); return;} 
    const query = argv[1].trim();

    const _testFailed = err => {const error=`Error AI search testing failed.${err?" Error was "+err:""}\n`; LOG.error(error); LOG.console(error);}
    try{
        const jsonReq = {id: TEST_ID, org: TEST_ORG, question: query};
        const queryResult = await enterpriseassistant.doService(jsonReq);
        if ((!queryResult) || (!queryResult.result)) {_testFailed("Search failed."); return false;}
        const output = JSON.stringify(queryResult, null, 2); 
        LOG.info(output); LOG.console(output);
    } catch (err) {_testFailed(err); return false;}
}
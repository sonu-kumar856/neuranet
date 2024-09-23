/**
 * Deals with AI apps.
 * 
 * (C) 2023 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const yaml = require("yaml");
const fs = require('fs');
const fspromises = require("fs").promises;
const path = require('path');
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;
const aiutils = require(`${NEURANET_CONSTANTS.LIBDIR}/aiutils.js`);
const dblayer = require(`${NEURANET_CONSTANTS.LIBDIR}/dblayer.js`);
const fileindexer = require(`${NEURANET_CONSTANTS.LIBDIR}/fileindexer.js`);

const brainhandler = require(`${NEURANET_CONSTANTS.LIBDIR}/brainhandler.js`);

const APP_CACHE = {}, FLOWSECTION_CACHE = {}, DEBUG_MODE = NEURANET_CONSTANTS.CONF.debug_mode;

exports.DEFAULT_ENTRY_FUNCTIONS = {llm_flow: "answer", pregen_flow: "generate"};
exports.AIAPP_STATUS = {PUBLISHED: "published", UNPUBLISHED: "unpublished"};

/**
 * Returns the flow object of the YAML file for the given ai application
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @param {string} flow_section The flow section name
 * @returns The flow object of the YAML file for the given ai application
 */
exports.getAIAppObject = async function(id, org, aiappid, flow_section) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const app = await exports.getAIApp(id, org, aiappid), flowCacheKey = `${id}_${org}_${aiappid}_${flow_section}`;

    if (!app[flow_section]) return [];

    if (typeof app[flow_section] === "string") {  // flow is in an external file
        if (FLOWSECTION_CACHE[flowCacheKey] && (!DEBUG_MODE)) return FLOWSECTION_CACHE[flowCacheKey];
        else FLOWSECTION_CACHE[flowCacheKey] = app[flow_section].toLowerCase().endsWith("yaml") ?
            yaml.parse(await fspromises.readFile(`${_getAppDir(id, org, aiappid)}/${app[flow_section]}`, "utf8")) :
            JSON.parse(await fspromises.readFile(`${_getAppDir(id, org, aiappid)}/${app[flow_section]}`, "utf8"));
        return FLOWSECTION_CACHE[flowCacheKey];
    } else return app[flow_section];  // flow is inline
}

/**
 * Returns the LLM gen object (llm_flow) of the YAML file for the given ai application
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns The LLM gen object (llm_flow) of the YAML file for the given ai application
 */
exports.getLLMGenObject = (id, org, aiappid) => exports.getAIAppObject(id, org, aiappid, "llm_flow");

/**
 * Returns the pre gen object (pregen_flow) of the YAML file for the given ai application
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns The pre-gen (pregen_flow) object of the YAML file for the given ai application
 */
exports.getPregenObject = (id, org, aiappid) => exports.getAIAppObject(id, org, aiappid, "pregen_flow");

/**
 * Returns the AI app object itself - the overall AI app object.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns The AI app object itself - the overall AI app object.
 */
exports.getAIApp = async function(id, org, aiappid) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const appCacheKey = `${org}_${aiappid}`;
    if ((!DEBUG_MODE) && APP_CACHE[appCacheKey]) return APP_CACHE[appCacheKey];

    try {
        const appFile = exports.getAppFile(id, org, aiappid), appFileYaml = await fspromises.readFile(appFile, "utf8"),
            app = yaml.parse(appFileYaml); APP_CACHE[appCacheKey] = app;
        return APP_CACHE[appCacheKey];
    } catch (err) { // app file parsing issue
        if (!NEURANET_CONSTANTS.CONF.dynamic_aiapps) {  // dynamic apps not supported, we can't do anything else
            LOG.error(`AI app parsing error for ID ${aiappid} for org ${org}.`);
            throw err; 
        }

        // dynamic app support will allow for partitioned DBs with app IDs but using default YAML as the app definition
        LOG.warn(`Using dynamic app for app ID ${aiappid} for org ${org}, as static app for this ID not found.`);
        const aiappidDefaultForOrg = await brainhandler.getDefaultAppIDForOrg(org), 
            appFileDefaultForOrg = exports.getAppFile(id, org, aiappidDefaultForOrg),
            appDefaultYamlForOrg = await fspromises.readFile(appFileDefaultForOrg, "utf8");
        const appDefaultForOrg = yaml.parse(appDefaultYamlForOrg); appDefaultForOrg.id = aiappid;
        return appDefaultForOrg;
    }
}

/**
 * Returns the default AI app
 * @return {object} The default AI app object
 */
exports.getDefaultAIApp = async _ => {
    const aiappidDefault = brainhandler.getDefaultAppIDForOrg(org), 
        appFileDefault = exports.getAppFile(NEURANET_CONSTANTS.DEFAULT_ID, NEURANET_CONSTANTS.DEFAULT_ORG, aiappidDefault),
        appDefaultYaml = await fspromises.readFile(appFileDefault, "utf8");
    const app = yaml.parse(appDefaultYaml);
    return app;
}

/**
 * Returns AI model taking into account app's global overrides.
 * @param {string} model_name The model name
 * @param {object} model_overrides The overrides for this model, or undefined if none
 * @param {string} id The ID - if not provided then global overrides don't take effect
 * @param {string} org The org - if not provided then global overrides don't take effect
 * @param {string} aiappid The AI app ID - if not provided then global overrides don't take effect
 * @returns The AI model taking into account app's global overrides.
 */
exports.getAIModel = async function(model_name, model_overrides={}, id, org, aiappid) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const aiapp = (id && org && aiappid) ? await exports.getAIApp(id, org, aiappid) : {global_models: []};
    let globalOverrides = {}; for (const globalModel of aiapp.global_models) if (globalModel.name == model_name) {
        globalOverrides = globalModel.model_overrides; break; }
    const final_overrides = {...globalOverrides, ...model_overrides};
    return await aiutils.getAIModel(model_name, final_overrides);
}

/**
 * Returns the JS module, whether plugin or loaded from app, for YAML command modules
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @param {string} command The command name
 * @return The JS module, whether plugin or loaded from app, for YAML command modules
 */
exports.getCommandModule = async function(id, org, aiappid, command) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const aiapp = await exports.getAIApp(id, org, aiappid);
    if (aiapp.modules?.[command]) return require(`${exports.getAppDir(id, org, aiappid)}/${aiapp.modules[command]}`);
    else return await NEURANET_CONSTANTS.getPlugin(command);    // if it is not part of the app then must be built-in
}

/** @return For YAML keys with additional properties e.g. condition_js, returns the raw key name e.g. condition */
exports.extractRawKeyName = key => key.lastIndexOf("_") != -1 ? key.substring(0, key.lastIndexOf("_")) : key;

/**
 * Returns AI application directory.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns AI application directory.
 */
exports.getAppDir = (id, org, aiappid) => brainhandler.isThisDefaultOrgsDefaultApp(id, org, aiappid) ?
    `${NEURANET_CONSTANTS.AIAPPDIR}/${NEURANET_CONSTANTS.DEFAULT_ORG}/${aiappid}` : `${NEURANET_CONSTANTS.AIAPPDIR}/${org}/${aiappid}`;
    
/**
 * Returns the list of all AI apps for the given org.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {boolean} onlyPublished If true then only published apps are returned
 * @returns Array of AI app objects for given org (complete YAML objects)
 */
exports.getAllAIAppsForOrg = async (id, org, onlyPublished) => {
    org = org.toLowerCase();
    const aiappsDB = await dblayer.getAllAIAppsForOrg(org, onlyPublished?exports.AIAPP_STATUS.PUBLISHED:undefined);
    const retAiAppObjects = []; for (const aiappThis of aiappsDB) {
        const aiappObject = await exports.getAIApp(id, org, aiappThis.aiappid);
        retAiAppObjects.push(aiappObject);
    }
    return retAiAppObjects;
}

/**
 * Initializes and adds the given AI app for the given org, but doesn't
 * publish it.
 * @param {string} aiappid The AI app ID
 * @param {string} label The AI app label for the interface section
 * @param {string} id The user ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.initNewAIAppForOrg = async function(aiappid, label, id, org) {    
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const defaultAppDir = exports.getAppDir(NEURANET_CONSTANTS.DEFAULT_ID, NEURANET_CONSTANTS.DEFAULT_ORG, 
        NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP), newAppDir = exports.getAppDir(id, org, aiappid);

    const logErrorExists = LOG.error(`AI app init failed for ${org} for AI app ${aiappid} due to existing app.`);
    try {await fspromises.access(newAppDir); logErrorExists(); return false;} catch (err) { // don't overwrite existing apps
        if (err.code !== "ENOENT") {logErrorExists(); return false;} };

    try {
        let result = true; serverutils.walkFolder(defaultAppDir, async (fullpath, _stats, relativePath) => {
            if (!result) return;    // already failed, no point wasting time walking further
            if (relativePath.toLowerCase().endsWith(".yaml")) relativePath = relativePath.replace(NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP, aiappid);    // replace app ID in path
            let fileContents = await fspromises.readFile(fullpath, "utf8");
            if (fullpath.toLowerCase().endsWith(".yaml")) fileContents = fileContents.replace(    // fix app IDs and labels
                NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP, aiappid).replace(
                    `label: ${NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP_LABEL}`, `label: ${label}`); 
            const fileBuffer = Buffer.from(fileContents, "utf8");
            result = await fileindexer.addFileToCMSRepository(id, org,   // app dir is CMS managed so this is needed
                fileBuffer, relativePath, `AI app file for ${aiappid}`, brainhandler.createExtraInfo(
                    id, org, aiappid, undefined, NEURANET_CONSTANTS.AIAPPMODES.EDIT), true);
        });
        if (result) result = await dblayer.addOrUpdateAIAppForOrg(org, aiappid, exports.AIAPP_STATUS.UNPUBLISHED);
        else {
            LOG.error(`DB update for AI app ${aiappid} for org ${org} failed.`);
            try {await utils.rmrf(newAppDir);} catch (err) {LOG.error(`Error ${err} cleaning up ${newAppDir} for org ${org}.`);}
        }
        return result;
    } catch (err) {
        LOG.error(`AI app init failed for ${org} for AI app ${aiappid} due to error ${err}`);
        return false;
    }
}


/**
 * Deletes the given AI app for the given org.
 * @param {string} aiappid The AI app ID
 * @param {string} id The user ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */

exports.deleteAIAppForOrg = async function (aiappid, id, org) {
    aiappid = aiappid.toLowerCase();
    org = org.toLowerCase();

    const newAppDir = exports.getAppDir(id, org, aiappid);
    const archiveDirPath = `${NEURANET_CONSTANTS.DBDIR}/archive`;
    const sourceFolderPath = `${NEURANET_CONSTANTS.DBDIR}/ai_db/${org}/${aiappid}`;
    const zipFilePath = path.join(archiveDirPath, `${aiappid}.zip`);

    try {
        // Ensure archive directory exists
        await serverutils.createDirectory(archiveDirPath);

        // Zip the folder and remove the source folder after archiving
        await serverutils.zipFolder(sourceFolderPath, zipFilePath);
        await serverutils.rmrf(sourceFolderPath);

        // Remove the app directory
        const result = await serverutils.rmrf(newAppDir);
        if (!result) {
            throw new Error(`Failed to delete hosting folder for app ${aiappid} for org ${org}.`);
        }

        // Delete app entry in the database
        return await dblayer.deleteAIAppforOrg(org, aiappid);

    } catch (err) {
        if (err.code !== 'ENOENT') {
            LOG.error(`Error deleting AI app for org ${org}: ${err.message}`);
        }
        return false;
    }
}



/**
 * Publishes (but doesn't add) the given AI app for the given org.
 * @param {string} aiappid The AI app ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.publishAIAppForOrg = async function(aiappid, org) {  
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    return await dblayer.addOrUpdateAIAppForOrg(org, aiappid, exports.AIAPP_STATUS.PUBLISHED);
}

/**
 * Unpublishes (but doesn't delete) the given AI app for the given org.
 * @param {string} aiappid The AI app ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.unpublishAIAppForOrg = async function(aiappid, org) {  
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();  
    return await dblayer.addOrUpdateAIAppForOrg(org, aiappid, exports.AIAPP_STATUS.UNPUBLISHED);
}

/**
 * Returns AI application file.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns AI application file.
 */
exports.getAppFile = (id, org, aiappid) => `${exports.getAppDir(id, org, aiappid)}/${aiappid}.yaml`;
/**
 * Deletes the given file. 
 * (C) 2020 TekMonks. All rights reserved.
 */
const path = require("path");
const fspromises = require("fs").promises;
const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const XBIN_CONSTANTS = LOGINAPP_CONSTANTS.ENV.XBIN_CONSTANTS;
const cms = require(`${XBIN_CONSTANTS.LIB_DIR}/cms.js`);
const blackboard = require(`${CONSTANTS.LIBDIR}/blackboard.js`);
const db = require(`${XBIN_CONSTANTS.LIB_DIR}/xbindb.js`).getDB();
const uploadfile = require(`${XBIN_CONSTANTS.API_DIR}/uploadfile.js`);

exports.doService = async (jsonReq, _, headers) => {
	if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
	
	LOG.debug("Got deletefile request for path: " + jsonReq.path);
	const headersOrLoginIDAndOrg = jsonReq.id && jsonReq.org ? 
		{xbin_id: jsonReq.id, xbin_org: jsonReq.org, headers} : headers;

	const fullpath = path.resolve(`${await cms.getCMSRoot(headersOrLoginIDAndOrg)}/${jsonReq.path}`);
	if (!await cms.isSecure(headersOrLoginIDAndOrg, fullpath)) {LOG.error(`Path security validation failure: ${jsonReq.path}`); return CONSTANTS.FALSE_RESULT;}

	try {await fspromises.access(fullpath)} catch (err) { 
		if (err.code == "ENOENT") {
			LOG.warn(`Told to delete file ${fullpath}, which doesn't exist. Ignoring.`);
			return CONSTANTS.TRUE_RESULT;
		}
	}

	const ip = utils.getLocalIPs()[0], id = cms.getID(headersOrLoginIDAndOrg), org = cms.getOrg(headersOrLoginIDAndOrg);

	try {
		await rmrf(fullpath, id, org, ip); 
		return CONSTANTS.TRUE_RESULT;
	} catch (err) {LOG.error(`Error deleting  path: ${fullpath}, error is: ${err}`); return CONSTANTS.FALSE_RESULT;}
}

exports.deleteFile = async (headersOrIDAndOrg, cmsPath, noevent) => {
	const ip = utils.getLocalIPs()[0], id = headersOrIDAndOrg.xbin_id||cms.getID(headersOrIDAndOrg), 
		org = headersOrIDAndOrg.xbin_org||cms.getOrg(headersOrIDAndOrg);

	LOG.debug("Got delete file request for cms path: " + cmsPath + " for ID: " + id + " and org: " + org);

	const fullpath = path.resolve(`${await cms.getCMSRoot(headersOrIDAndOrg)}/${cmsPath}`);
	if (!await cms.isSecure(headersOrIDAndOrg, fullpath)) {LOG.error(`Path security validation failure: ${fullpath}`); return CONSTANTS.FALSE_RESULT;}

	await rmrf(fullpath, id, org, ip, noevent);
	return CONSTANTS.TRUE_RESULT;
}

exports.getFullPath = uploadfile.getFullPath;

async function rmrf(path, id, org, ip, noevent) {
	const _deleteFile = async path => {
		await unlinkFileAndRemoveFromDB(path); 
		if (!noevent) blackboard.publish(XBIN_CONSTANTS.XBINEVENT, {type: XBIN_CONSTANTS.EVENTS.FILE_DELETED, path, id, org, ip, isxbin: true});
	}

	if ((await fspromises.stat(path)).isFile()) { await _deleteFile(path); return; }

	const entries = await fspromises.readdir(path);
	for (const entry of entries) {
		const stats = await uploadfile.getFileStats(`${path}/${entry}`);
		if (stats.xbintype == XBIN_CONSTANTS.XBIN_FILE) await _deleteFile(`${path}/${entry}`); 
		else if (stats.xbintype == XBIN_CONSTANTS.XBIN_FOLDER) await rmrf(`${path}/${entry}`);
	}
	await fspromises.rmdir(path); try {await uploadfile.deleteDiskFileMetadata(path);} catch (err) {};
}

async function unlinkFileAndRemoveFromDB(path) {
	await db.runCmd("DELETE FROM shares WHERE fullpath = ?", [path]);	
	await fspromises.unlink(path); try {await uploadfile.deleteDiskFileMetadata(path);} catch (err) {};
}

const validateRequest = jsonReq => (jsonReq && jsonReq.path);
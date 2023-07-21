/**
 * Handles upload requests. 
 * (C) 2020 TekMonks. All rights reserved.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const fspromises = fs.promises;
const stream = require("stream");
const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const crypt = require(`${CONSTANTS.LIBDIR}/crypt.js`);
const XBIN_CONSTANTS = LOGINAPP_CONSTANTS.ENV.XBIN_CONSTANTS;
const cms = require(`${XBIN_CONSTANTS.LIB_DIR}/cms.js`);
const CONF = require(`${XBIN_CONSTANTS.CONF_DIR}/xbin.json`);
const quotas = require(`${XBIN_CONSTANTS.LIB_DIR}/quotas.js`);
const blackboard = require(`${CONSTANTS.LIBDIR}/blackboard.js`);
const addablereadstream = require(`${XBIN_CONSTANTS.LIB_DIR}/addablereadstream.js`)
const ADDABLE_STREAM_TIMEOUT = CONF.UPLOAD_STREAM_MAX_WAIT||120000;	// 2 minutes to receive new data else we timeout

const _existing_streams = [];	// holds existing streams for files under upload progress

exports.doService = async (jsonReq, _servObject, headers, _url) => {
	if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
	
	LOG.debug("Got uploadfile request for path: " + jsonReq.path);

	const transferID = jsonReq.transfer_id || Date.now(), fullpath = path.resolve(`${await cms.getCMSRoot(headers)}/${jsonReq.path}`);
	if (!await cms.isSecure(headers, fullpath)) {LOG.error(`Path security validation failure: ${jsonReq.path}`); return CONSTANTS.FALSE_RESULT;}
	
	LOG.debug("Resolved full path for upload file: " + fullpath);

	try {
        const matches = jsonReq.data.match(/^data:.*;base64,(.*)$/); 
        if (!matches) throw `Bad data encoding: ${jsonReq.data}`;
		const bufferToWrite = Buffer.from(matches[1], "base64");
		if (!(await quotas.checkQuota(headers, bufferToWrite.length)).result) throw (`Quota is full write failed for path ${fullpath}.`);
        
		await exports.writeChunk(headers, transferID, fullpath, bufferToWrite, jsonReq.startOfFile, jsonReq.endOfFile);

		return {...CONSTANTS.TRUE_RESULT, transfer_id: transferID};
	} catch (err) {
		LOG.error(`Error writing to path: ${fullpath}, error is: ${err}, stack is ${err.stack}`); 
		try {await fspromises.unlink(fullpath); await exports.deleteDiskFileMetadata(fullpath)} catch(err) {};
		return {...CONSTANTS.FALSE_RESULT, transfer_id: transferID};
	}
}

exports.uploadFile = async function(xbin_id, xbin_org, readstreamOrContents, cmsPath, comment) {
	LOG.debug("Got uploadfile request for cms path: " + cmsPath + " for ID: " + xbin_id + " and org: " + xbin_org);

	const transferID = Date.now(), fullpath = path.resolve(`${await cms.getCMSRoot({xbin_id, xbin_org})}/${cmsPath}`);
	if (!await cms.isSecure({xbin_id, xbin_org}, fullpath)) {LOG.error(`Path security validation failure: ${fullpath}`); return CONSTANTS.FALSE_RESULT;}

	if (Buffer.isBuffer(readstreamOrContents)) {
		if (await exports.writeChunk({xbin_id, xbin_org}, transferID, fullpath, readstreamOrContents, true, 
			true, comment)) return CONSTANTS.TRUE_RESULT; else return CONSTANTS.FALSE_RESULT;
	} else if (readstreamOrContents instanceof stream.Readable) return new Promise(resolve => {
		let startOfFile = true, ignoreEvents = false;
		readstreamOrContents.on("data", async chunk => {
			if (ignoreEvents) return;	// failed already
			if (!await exports.writeChunk({xbin_id, xbin_org}, transferID, fullpath, chunk, startOfFile, 
				false, comment)) { resolve(CONSTANTS.FALSE_RESULT); ignoreEvents = true }; 
			startOfFile = false; 
		});
		readstreamOrContents.on("end", async _ => {
			if (ignoreEvents) return;	// failed already
			if (await exports.writeChunk({xbin_id, xbin_org}, transferID, fullpath, Buffer.from([]), false, 
				true, comment)) resolve(CONSTANTS.TRUE_RESULT); else resolve(CONSTANTS.FALSE_RESULT);
		});
	}); else return CONSTANTS.FALSE_RESULT;	// neither a buffer, nor a stream - we can't deal with it
}

exports.writeChunk = async function(headersOrLoginIDAndOrg, transferid, fullpath, chunk, startOfFile, 
		endOfFile, comment) {
	const temppath = path.resolve(`${fullpath}${transferid}${XBIN_CONSTANTS.XBIN_TEMP_FILE_SUFFIX}`)

	if (startOfFile) {	// delete the old files if they exist
		try {await fspromises.access(fullpath); await fspromises.unlink(fullpath);} catch (err) {};
		try {deleteDiskFileMetadata(fullpath);} catch (err) {};
	} 

	if (chunk.length > 0) await _appendOrWrite(temppath, chunk, startOfFile, endOfFile, exports.isZippable(fullpath));
	LOG.debug(`Added new ${chunk.length} bytes to the file at eventual path ${fullpath} using temp path ${temppath}.`);
	if (endOfFile) {
		await fspromises.rename(temppath, fullpath);
		LOG.info(`Finished uploading file ${fullpath} successfully.`);
		blackboard.publish(XBIN_CONSTANTS.XBINEVENT, {type: XBIN_CONSTANTS.EVENTS.FILE_CREATED, path: fullpath, 
			ip: utils.getLocalIPs()[0], id: cms.getID(headersOrLoginIDAndOrg), org: cms.getOrg(headersOrLoginIDAndOrg), isxbin: true});
	}

	const cmspath = await cms.getCMSRootRelativePath(headersOrLoginIDAndOrg, fullpath)
	await exports.updateFileStats(fullpath, cmspath, chunk.length, endOfFile, XBIN_CONSTANTS.XBIN_FILE, comment);

	return true;
}

exports.writeUTF8File = async function (headers, inpath, data) {
	const fullpath = path.resolve(`${await cms.getCMSRoot(headers)}/${inpath}`);
	if (!await cms.isSecure(headers, fullpath)) throw `Path security validation failure: ${fullpath}`;

	let additionalBytesToWrite = data.length; 
	try {additionalBytesToWrite = data.length - (await exports.getFileStats(fullpath)).size;} catch (err) {};	// file may not exist at all
	if (!(await quotas.checkQuota(headers, additionalBytesToWrite)).result) throw `Quota is full write failed for ${fullpath}`;

	await _appendOrWrite(fullpath, data, true, true, exports.isZippable(fullpath));

	exports.updateFileStats(fullpath, inpath, data.length, true, XBIN_CONSTANTS.XBIN_FILE);	
}

exports.updateFileStats = async function (fullpathOrRequestHeaders, remotepath, dataLengthWritten, transferFinished, type, commentin) {
	const fullpath = typeof fullpathOrRequestHeaders !== 'string' ? (await _getSecureFullPath(fullpathOrRequestHeaders, remotepath)) : fullpathOrRequestHeaders;
	const metaPath = fullpath+XBIN_CONSTANTS.STATS_EXTENSION, clusterMemory = CLUSTER_MEMORY.get(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, {});
	const isWriteOpToAUploadAndNotFinished = dataLengthWritten && (!transferFinished);

	if (!clusterMemory.files_stats) clusterMemory.files_stats = {};
	if (!clusterMemory.files_stats[fullpath]) {
		if (!isWriteOpToAUploadAndNotFinished) {
			try {
				await fspromises.access(metaPath, fs.constants.W_OK & fs.constants.R_OK);
				clusterMemory.files_stats[fullpath] = await fspromises.readFile(metaPath, "utf8"); 
			} catch (err) {
				let stats; try {stats = await fspromises.stat(fullpath);} catch (err) {stats = {}};
				clusterMemory.files_stats[fullpath] = { ...stats, remotepath: exports.normalizeRemotePath(remotepath), size: 0, 
					byteswritten: 0, xbintype: type||(stats.isFile()?XBIN_CONSTANTS.XBIN_FILE:(stats.isDirectory()?XBIN_CONSTANTS.XBIN_FOLDER:"UNKNOWN")), 
					comment: commentin||"", disk_size: stats.size }; 
			} 
		} else clusterMemory.files_stats[fullpath] = { remotepath: exports.normalizeRemotePath(remotepath), size: 0, byteswritten: 0, 
			xbintype: type||(stats.isFile()?XBIN_CONSTANTS.XBIN_FILE:(stats.isDirectory()?XBIN_CONSTANTS.XBIN_FOLDER:"UNKNOWN")), 
			comment: commentin||"" }; 
	}
	
	if (dataLengthWritten !== undefined) {
		clusterMemory.files_stats[fullpath].byteswritten += dataLengthWritten; 
		clusterMemory.files_stats[fullpath].size = clusterMemory.files_stats[fullpath].byteswritten;
	}
	if (commentin) clusterMemory.files_stats[fullpath].comment = commentin;

	if (transferFinished) {
		if (!clusterMemory.files_stats[fullpath].birthtimeMs) {	// refresh stats if empty
			const stats = await fspromises.stat(fullpath);
			clusterMemory.files_stats[fullpath] = {...stats, ...clusterMemory.files_stats[fullpath], disk_size: stats.size};	
		}
		await fspromises.writeFile(metaPath, JSON.stringify(clusterMemory.files_stats[fullpath]));
		if (dataLengthWritten) clusterMemory.files_stats[fullpath].byteswritten = 0; 	// we updated due to a write and have finished uploading
	}

	CLUSTER_MEMORY.set(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, clusterMemory);
}

exports.getFileStats = async fullpath => {	// cache and return to avoid repeated reads
	const clusterMemory = CLUSTER_MEMORY.get(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, {});
	if (!clusterMemory.files_stats) clusterMemory.files_stats = {};
	if (!clusterMemory.files_stats[fullpath]) {
		const diskStats = await fspromises.lstat(fullpath);
		clusterMemory.files_stats[fullpath] = diskStats.isFile() ?
			JSON.parse(await fspromises.readFile(fullpath+XBIN_CONSTANTS.STATS_EXTENSION, "utf8")) : 
			{...diskStats, xbintype: diskStats.isDirectory()?XBIN_CONSTANTS.XBIN_FOLDER:"UNKNOWN", comment: "",
				size: diskStats.isDirectory()?await exports.getFolderSize(fullpath):diskStats.size};
	}
	return {...clusterMemory.files_stats[fullpath]};
}

exports.getFolderSize = async fullpath => {
	let size = 0; 
	await utils.walkFolder(fullpath, async (fullEntryPath, stats) => { if (stats.isFile()) 
		try { if (!XBIN_CONSTANTS.XBIN_IGNORE_PATH_SUFFIXES.includes(path.extname(fullEntryPath))) size += 
			JSON.parse(await fspromises.readFile( fullEntryPath+XBIN_CONSTANTS.STATS_EXTENSION, "utf8")).size; 
		} catch (err) {LOG.warn(`Can't find correct metadata for path ${fullpath} during uploadfile.getFolderSize().`)}
	}, true);
	return size;
}

exports.createFolder = async function(headers, inpath) {
	const fullpath = path.resolve(`${await cms.getCMSRoot(headers)}/${inpath}`);
	if (!await cms.isSecure(headers, fullpath)) throw (`Path security validation failure: ${inpath}`);
	try {await fspromises.mkdir(fullpath);} catch (err) {if (err.code !== "EEXIST") throw err; else LOG.warn("Told to create a folder which already exists, ignorning: "+fullpath);}	// already exists is ok
	await exports.updateFileStats(fullpath, inpath, undefined, true, XBIN_CONSTANTS.XBIN_FOLDER);
}

exports.isZippable = fullpath => !((CONF.DONT_GZIP_EXTENSIONS||[]).includes(path.extname(fullpath)));

exports.deleteDiskFileMetadata = async function(fullpath) {
	await fspromises.unlink(fullpath+XBIN_CONSTANTS.STATS_EXTENSION);
	const clusterMemory = CLUSTER_MEMORY.get(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, {});
	if (clusterMemory && clusterMemory.files_stats && clusterMemory.files_stats[fullpath]) {
		delete clusterMemory.files_stats[fullpath];
		CLUSTER_MEMORY.set(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, clusterMemory);
	}
}

exports.isMetaDataFile = path => path.endsWith(XBIN_CONSTANTS.STATS_EXTENSION);

exports.getFileForMetaDataFile = path => {
	if (exports.isMetaDataFile(path)) return path.substring(0, path.length-XBIN_CONSTANTS.STATS_EXTENSION.length);
	else return null;
}

exports.renameDiskFileMetadata = async function (oldpath, newpath, newRemotePath) {
	exports.copyDiskFileMetadata(oldpath, newpath, newRemotePath);
	if (path.resolve(oldpath) != path.resolve(newpath)) {
		fspromises.unlink(oldpath+XBIN_CONSTANTS.STATS_EXTENSION);
		const clusterMemory = CLUSTER_MEMORY.get(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, {});
		if (clusterMemory && clusterMemory.files_stats && clusterMemory.files_stats[oldpath]) delete clusterMemory.files_stats[oldpath];
	}
}

exports.updateDiskFileMetadataRemotePaths = async function (path, newRemotePath) {
	const clusterMemory = CLUSTER_MEMORY.get(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, {});
	const statsNew = clusterMemory.files_stats?.[path]||await exports.getFileStats(path); 
	statsNew.remotepath = exports.normalizeRemotePath(newRemotePath);
	await fspromises.writeFile(path+XBIN_CONSTANTS.STATS_EXTENSION, JSON.stringify(statsNew), "utf8");
	if (clusterMemory && clusterMemory.files_stats) {
		clusterMemory.files_stats[path] == {...statsNew};
		CLUSTER_MEMORY.set(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, clusterMemory);
	}
}

exports.copyDiskFileMetadata = async function (oldpath, newpath, newRemotePath) {
	const clusterMemory = CLUSTER_MEMORY.get(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, {});
	const statsNew = clusterMemory.files_stats?.[oldpath]||await exports.getFileStats(oldpath); 
	statsNew.remotepath = exports.normalizeRemotePath(newRemotePath);
	await fspromises.writeFile(newpath+XBIN_CONSTANTS.STATS_EXTENSION, JSON.stringify(statsNew), "utf8");
	if (clusterMemory && clusterMemory.files_stats) {
		clusterMemory.files_stats[newpath] == {...statsNew};
		CLUSTER_MEMORY.set(XBIN_CONSTANTS.MEM_KEY_UPLOADFILE, clusterMemory);
	}
}

exports.isFileConsistentOnDisk = async fullpath => {
	try {
		await fspromises.access(fullpath, fs.constants.R_OK);
		await fspromises.access(fullpath+XBIN_CONSTANTS.STATS_EXTENSION, fs.constants.R_OK);
		return true;
	} catch (err) {return false;}
}

exports.normalizeRemotePath = pathIn => pathIn.replace(/\\+/g, "/").replace(/\/+/g, "/");

async function _getSecureFullPath(headers, inpath) {
	const fullpath = path.resolve(`${await cms.getCMSRoot(headers)}/${inpath}`);
	if (!await cms.isSecure(headers, fullpath)) {LOG.error(`Path security validation failure: ${inpath}`); throw `Path security validation failure: ${inpath}`;}
	return fullpath;
}

function _appendOrWrite(inpath, buffer, startOfFile, endOfFile, isZippable) {
	const _createStreams = (path, reject, resolve) => {
		if (_existing_streams[path]) _deleteStreams(path);	// delete old streams if open

		_existing_streams[path] = { addablestream: addablereadstream.getAddableReadstream(ADDABLE_STREAM_TIMEOUT), 
			reject, resolve }; 
		LOG.debug(`Created readable stream with ID ${_existing_streams[path].addablestream.getID()} for path ${path}.`);
		let readableStream = _existing_streams[path].addablestream;
		if (isZippable) readableStream = readableStream.pipe(zlib.createGzip());	// gzip to save disk space and download bandwidth for downloads
		if (CONF.DISK_SECURED) readableStream = readableStream.pipe(crypt.getCipher(CONF.SECURED_KEY));
		_existing_streams[path].writestream = fs.createWriteStream(path, {"flags":"w"}); 
		_existing_streams[path].writestream.__org_xbin_writestream_id = Date.now();
		_existing_streams[path].closeWriteStream = true;
		readableStream.pipe(_existing_streams[path].writestream); 
		_existing_streams[path].writestream.on("finish", _=>{	// deleteStreams if the finish itself is not emitted by _deleteStreams
			if (_existing_streams[path].writestream.__org_xbin_writestream_id != 
					_existing_streams[path].ignoreWriteStreamFinishForID) {
				LOG.warn(`Finish write not issued by deleteStreams, deleted the streams as well. Path is ${path}, addablestream ID is ${_existing_streams[path].addablestream.getID()}.`);
				_existing_streams[path].closeWriteStream = false; _deleteStreams(path);
			} else LOG.info(`Finish write issued by deleteStreams, path is ${path}, addablestream ID is ${_existing_streams[path].addablestream.getID()}.`);
		}); 
		_existing_streams[path].writestream.on("error", error => { 
			LOG.error(`Error in the write stream for path ${path}, error is ${error}, addablestream ID is ${_existing_streams[path].addablestream.getID()}.`);
			_existing_streams[path].reject(error); _deleteStreams(path) 
		});
		_existing_streams[path].addablestream.on("read_drained", _ => {
			if (_existing_streams[path]) {
				_existing_streams[path].resolve();
				LOG.debug(`Resolved writing for path ${path} with buffer size of ${buffer.length} bytes for stream with ID ${_existing_streams[path].addablestream.getID()}.`);
			} else LOG.warn(`Drained issued for an addablestream which doesn't exist anymore. The path is ${path}.`);
		});
	}

	const _deleteStreams = path => {
		if (!_existing_streams[path]) return;
		LOG.info(`Deleteting streams for path ${path}. Addable stream ID is ${(_existing_streams[path].addablestream?.getID())||"unknown"}`);
		if (_existing_streams[path].addablereadstream) _existing_streams[path].addablestream.end(); 
		if (_existing_streams[path].closeWriteStream) try {
			_existing_streams[path].ignoreWriteStreamFinishForID = _existing_streams[path].writestream.__org_xbin_writestream_id;
			_existing_streams[path].writestream.close(); 
		} catch (err) {LOG.warn(`Error closing write stream with for path ${path}, error is ${err}. Addable stream ID is ${(_existing_streams[path].addablestream?.getID())||"unknown"}`);}
		delete _existing_streams[path];
	}

	return new Promise((resolve, reject) => {
		if (startOfFile) _createStreams(inpath, resolve, reject);

		if (!_existing_streams[inpath]) {reject("Error: Missing stream for file "+inpath); return;}

		_existing_streams[inpath].resolve = resolve; _existing_streams[inpath].reject = reject;	// update these so events calls the right ones
		_existing_streams[inpath].addablestream.addData(buffer); 
		LOG.debug(`Added data for path ${inpath} with buffer size of ${buffer.length} bytes for stream with ID ${_existing_streams[inpath].addablestream.getID()}, total bytes added are ${_existing_streams[inpath].addablestream.length}.`);
		if (endOfFile) _existing_streams[inpath].addablestream.end(); 
	});
}

const validateRequest = jsonReq => (jsonReq && jsonReq.path && jsonReq.data && 
	(jsonReq.startOfFile !== undefined) && (jsonReq.endOfFile  !== undefined) && (jsonReq.startOfFile || jsonReq.transfer_id));
#! /usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import unzipper from 'unzipper';
import fs from 'fs-extra-promise';
import { Readable } from 'stream';
import path from 'path';

const TEMP_FOLDER = './temp';
const ACTION_ZIP_FILE = './temp/action';
const OUTPUT_DIR = './temp/extracted';

fs.emptyDirSync(TEMP_FOLDER);

const client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function report(status, data) {
    console.log('cr-agent: Report', status, data);
    // TODO - remove this condition when the control endpoint is ready
    if (!process.env.CONTROL_ENDPOINT) {
      return;
    }
    await axios.put(process.env.CONTROL_ENDPOINT, {
      status,
      ...data,
    });
  }
  
  async function reportStarted() {
    await report('STARTED');
  }
  
  async function reportCompleted(data) {
    await report('COMPLETED', { data });
  }
  
  async function reportFailed(err) {
    await report('FAILED', {
      error: {
        message: err.message,
      },
    });
  }
  

const downloadActionCode = async () => {
  const fileStream = fs.createWriteStream(ACTION_ZIP_FILE);
  const input = {
    Bucket: process.env.ACTION_BUCKET,
    Key: process.env.ACTION_FILE,
  }
  const command = new GetObjectCommand(input);
  const response = await client.send(command);
  Readable.from(response.Body).pipe(fileStream);
  await new Promise((resolve) => {
    fileStream.on('finish', resolve);
  });
}

async function extractCode() {
  await new Promise((resolve, reject) => {
    const writeStream = unzipper.Extract({ path: OUTPUT_DIR });
    writeStream.on('close', resolve);
    writeStream.on('error', reject);
    fs.createReadStream(ACTION_ZIP_FILE).pipe(writeStream);
  });
}

async function run() {
  console.log('Hello from runtime-agent!');
  try{
    reportStarted();
    await downloadActionCode();
    await extractCode();
    const params = {};
    for (let key in process.env) {
      if (key.startsWith('CA_PARAM_')) {
        params[key.replace('CA_PARAM_', '')] = process.env[key];
      }
    }
    const modulePath = path.resolve(`${OUTPUT_DIR}/index.js?r=${Date.now()}`)
    const mod = await import(modulePath);
    const output = await mod.default(params);
    await reportCompleted(output);
    console.log(output);
    process.exit(0); // exit with sucess
  }catch(e){
    console.error(e);
    await reportFailed(e);
    process.exit(1); // exit with error
  }
}

run();
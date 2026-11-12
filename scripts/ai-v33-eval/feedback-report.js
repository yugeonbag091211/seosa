#!/usr/bin/env node
'use strict';
// Local-only evidence compiler. Do not pass raw user conversations as review labels.
// Usage: node scripts/ai-v33-eval/feedback-report.js --responses <jsonl> [--reviews <jsonl>] [--output <json>]
const fs=require('node:fs');
const path=require('node:path');
const {normalizeEvidence,summarizeEvidence}=require('./feedback-evidence');
function arg(key){const idx=process.argv.indexOf(key);return idx>=0?process.argv[idx+1]:null;}
function jsonl(file){
 if(!file)return [];
 return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(x=>x.trim()).map((line,i)=>{
   try{return JSON.parse(line);}catch{throw new Error('Invalid JSON at '+file+':'+(i+1));}
 });
}
function main(){
 const source=arg('--responses');
 if(!source)throw new Error('Missing --responses JSONL file');
 const responses=jsonl(source), grades=jsonl(arg('--reviews'));
 const gradeMap=new Map();
 for(const grade of grades){
   if(typeof grade.id!=='string'||gradeMap.has(grade.id))throw new Error('Invalid/duplicate reviewer label');
   gradeMap.set(grade.id,grade);
 }
 const evidence=responses.map(r=>normalizeEvidence(r,gradeMap.get(r.id)||{}));
 const summary=summarizeEvidence(evidence);
 const output=arg('--output');
 if(output){
   fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
   fs.writeFileSync(output,JSON.stringify({schemaVersion:1,summary,evidence},null,2)+'\n','utf8');
 }
 console.log(JSON.stringify({summary,output:output?path.resolve(output):null},null,2));
}
try{main();}catch(e){console.error('ERROR '+e.message);process.exitCode=1;}
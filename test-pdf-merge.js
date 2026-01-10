/**
 * Test Script for Brisk API and PDF Merge Flow
 * This script tests:
 * 1. Brisk Certificate API creation
 * 2. Brisk PDF download
 * 3. Finding Reliance PDF
 * 4. Merging PDFs via API
 * 5. Uploading to AWS S3
 * 6. Updating online policy schema
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const AWS = require('aws-sdk');
const http = require('http');
const https = require('https');
require('dotenv').config();

// Configure AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_S3_ACCESSKEY_ID,
    secretAccessKey: process.env.AWS_S3_SECRET_ACCESSKEY,
    region: 'ap-south-1'
});

// Test data - replace with your actual policy data
const testData = {
    _id: '6943c17251c7a9f762b68b8d',
    policyId: 'OP53347dfdershdfwsdsdsss53e9gfj5etrt169',
    userId: '65a343220a6016a8f93424e7',
    // Brisk Certificate test data
    CustomerName: 'RETO TR',
    MobileNo: '7890767890',
    EmailID: 'karthi123@gmail.com',
    City: 'CHENNAI',
    State: 'TAMIL NADU',
    CustomerGender: 'Male',
    NomineeName: 'TESTING',
    NomineeGender: 'Male',
    Relation: 'Brother',
    Make: 'HONDA',
    Model: 'DIO DLX OBD 2',
    EngineNo: `JK36EG${Date.now().toString().slice(-6)}`, // Keeping it dynamic for Brisk API
    ChassisNo: `MD626DG${Date.now().toString().slice(-8)}`, // Keeping it dynamic for Brisk API
    RegistrationNo: 'tyu66456',
    PaymentMode: 'FromWallet',
    Address_Line1: '54 TEST',
    Address_Line2: 'TEST DFERT',
    PlanName: 'TWHRN30K3S244',
    CustomerDOB: '08-17-2000',
    loginid: 'masterwallet@gmail.com',
    VehicleType: 'TW',
    Gstno: '',
    Flaxprice: '422',
    policyType: 'cpa/rsa'
};

/**
 * Test Brisk Certificate API
 */
async function testBriskAPI() {
    console.log('🔵 STEP 1: Testing Brisk Certificate API...\n');

    try {
        // Prepare Brisk API payload
        const briskPayload = {
            CustomerName: testData.CustomerName,
            MobileNo: testData.MobileNo,
            EmailID: testData.EmailID,
            City: testData.City,
            State: testData.State,
            CustomerGender: testData.CustomerGender,
            NomineeName: testData.NomineeName,
            NomineeGender: testData.NomineeGender,
            Relation: testData.Relation,
            Make: testData.Make,
            Model: testData.Model,
            EngineNo: testData.EngineNo,
            ChassisNo: testData.ChassisNo,
            RegistrationNo: testData.RegistrationNo,
            PaymentMode: testData.PaymentMode,
            Address_Line1: testData.Address_Line1,
            Address_Line2: testData.Address_Line2,
            PlanName: testData.PlanName,
            CustomerDOB: testData.CustomerDOB,
            loginid: testData.loginid,
            VehicleType: testData.VehicleType,
            Gstno: testData.Gstno,
            Flaxprice: testData.Flaxprice,
            policyType: testData.policyType
        };

        console.log('📤 Sending Brisk Certificate request...');
        console.log('   API: http://192.168.1.7:8080/api/createBriskCertificate');

        const briskResponse = await axios.post(
            'http://192.168.1.7:8080/api/createBriskCertificate',
            briskPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'clientid': testData.userId,
                    'userid': testData.userId
                },
                timeout: 30000
            }
        );

        console.log(`✅ Brisk Certificate created successfully!`);
        console.log(`   Response status: ${briskResponse.status}`);
        console.log(`   Full Response:`, JSON.stringify(briskResponse.data, null, 2));

        // Extract the actual data (it's nested under data.data)
        const responseData = briskResponse.data?.data || briskResponse.data;

        if (responseData) {
            console.log(`   Policy ID: ${responseData.policyId || 'N/A'}`);
            console.log(`   Download URL: ${responseData.downloadUrl || 'N/A'}`);
        }

        if (responseData && responseData.downloadUrl) {
            const downloadUrl = responseData.downloadUrl;
            const policyId = responseData.policyId || `test_${Date.now()}`;

            console.log(`\n📥 Downloading Brisk PDF...`);

            // Download the PDF using http/https
            const protocol = downloadUrl.startsWith('https') ? https : http;

            const briskPdfDir = path.join(__dirname, 'brisk_certificates');
            if (!fs.existsSync(briskPdfDir)) {
                fs.mkdirSync(briskPdfDir, { recursive: true });
            }

            const briskPdfPath = path.join(briskPdfDir, `${policyId}.pdf`);

            await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(briskPdfPath);

                protocol.get(downloadUrl, (response) => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`Failed to download PDF. Status: ${response.statusCode}`));
                        return;
                    }

                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });

                    file.on('error', (err) => {
                        fs.unlinkSync(briskPdfPath);
                        reject(err);
                    });
                }).on('error', (err) => {
                    if (fs.existsSync(briskPdfPath)) {
                        fs.unlinkSync(briskPdfPath);
                    }
                    reject(err);
                });
            });

            const fileSize = fs.statSync(briskPdfPath).size;
            console.log(`✅ Brisk PDF downloaded and saved!`);
            console.log(`   File path: ${briskPdfPath}`);
            console.log(`   File size: ${fileSize} bytes\n`);

            return {
                success: true,
                policyId: policyId,
                downloadUrl: downloadUrl,
                localPath: briskPdfPath
            };
        } else {
            throw new Error('No download URL in Brisk API response');
        }

    } catch (error) {
        console.error('❌ Brisk API test failed!');
        console.error('Error:', error.message);

        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }

        throw error;
    }
}

/**
 * Test PDF Merge and Upload Flow
 */
async function testPDFMergeFlow() {
    console.log('� STEP 2: Testing PDF Merge and Upload Flow...\n');

    try {
        // Find Reliance PDF
        console.log('📄 Finding Reliance PDF...');
        const reliancePdfDir = path.join(__dirname, 'reliance_pdf');

        if (!fs.existsSync(reliancePdfDir)) {
            throw new Error(`Reliance PDF directory not found: ${reliancePdfDir}`);
        }

        const pdfFiles = fs.readdirSync(reliancePdfDir)
            .filter(file => file.endsWith('.pdf'))
            .map(file => ({
                name: file,
                path: path.join(reliancePdfDir, file),
                time: fs.statSync(path.join(reliancePdfDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (pdfFiles.length === 0) {
            throw new Error('No PDF files found in reliance_pdf folder');
        }

        const reliancePdfPath = pdfFiles[0].path;
        console.log(`✅ Found Reliance PDF: ${reliancePdfPath}`);
        console.log(`   File size: ${fs.statSync(reliancePdfPath).size} bytes\n`);

        // Find Brisk PDF
        console.log('📄 Finding Brisk PDF...');
        const briskPdfDir = path.join(__dirname, 'brisk_certificates');

        if (!fs.existsSync(briskPdfDir)) {
            throw new Error(`Brisk PDF directory not found: ${briskPdfDir}`);
        }

        const briskPdfFiles = fs.readdirSync(briskPdfDir)
            .filter(file => file.endsWith('.pdf'))
            .map(file => ({
                name: file,
                path: path.join(briskPdfDir, file),
                time: fs.statSync(path.join(briskPdfDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (briskPdfFiles.length === 0) {
            throw new Error('No PDF files found in brisk_certificates folder');
        }

        const briskPdfPath = briskPdfFiles[0].path;
        console.log(`✅ Found Brisk PDF: ${briskPdfPath}`);
        console.log(`   File size: ${fs.statSync(briskPdfPath).size} bytes\n`);

        // Read PDFs as buffers
        console.log('📖 Reading PDFs as buffers...');
        const reliancePdfBuffer = fs.readFileSync(reliancePdfPath);
        const briskPdfBuffer = fs.readFileSync(briskPdfPath);
        console.log(`✅ Reliance PDF loaded: ${reliancePdfBuffer.length} bytes`);
        console.log(`✅ Brisk PDF loaded: ${briskPdfBuffer.length} bytes\n`);

        // Create FormData and merge PDFs
        console.log('🔄 Calling merge-pdf API...');
        const formData = new FormData();
        formData.append('files', reliancePdfBuffer, {
            filename: 'reliance.pdf',
            contentType: 'application/pdf'
        });
        formData.append('files', briskPdfBuffer, {
            filename: 'brisk.pdf',
            contentType: 'application/pdf'
        });

        const mergeResponse = await axios.post(
            'http://192.168.1.7:3010/api/merge-pdf',
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'clientid': testData.userId,
                    'userid': testData.userId
                },
                responseType: 'arraybuffer',
                timeout: 30000
            }
        );

        console.log(`✅ PDFs merged successfully!`);
        console.log(`   Response status: ${mergeResponse.status}`);
        console.log(`   Merged PDF size: ${mergeResponse.data.length} bytes\n`);

        // Save merged PDF temporarily
        console.log('💾 Saving merged PDF temporarily...');
        const mergedPdfPath = path.join(__dirname, 'temp_merged', `test_merged_${Date.now()}.pdf`);
        const mergedDir = path.dirname(mergedPdfPath);

        if (!fs.existsSync(mergedDir)) {
            fs.mkdirSync(mergedDir, { recursive: true });
        }

        fs.writeFileSync(mergedPdfPath, mergeResponse.data);
        console.log(`✅ Merged PDF saved: ${mergedPdfPath}\n`);

        // Upload to AWS S3
        console.log('☁️  Uploading merged PDF to AWS S3...');
        const s3Key = `MergedPolicies/${testData.policyId}_merged_test.pdf`;

        const uploadParams = {
            Bucket: process.env.AWS_BUCKET_NAME || process.env.S3_BUCKET_NAME,
            Key: s3Key,
            Body: fs.readFileSync(mergedPdfPath),
            ContentType: 'application/pdf',
            ACL: 'private'
        };

        const s3UploadResult = await s3.upload(uploadParams).promise();
        console.log(`✅ Merged PDF uploaded to S3!`);
        console.log(`   S3 Location: ${s3UploadResult.Location}`);
        console.log(`   S3 Key: ${s3UploadResult.Key}\n`);

        // Update online policy schema
        console.log('📝 Updating online policy schema (Direct MongoDB)...');
        const updateData = {
            mergedPolicyPdf: {
                fileName: `${testData.policyId}_merged_test.pdf`,
                key: s3Key,
                location: s3UploadResult.Location
            },
            updatedAt: new Date()
        };

        try {
            // Establish direct MongoDB connection
            const mongoose = require('mongoose');
            const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://royal-product:Rayal123@royal-product-cluster.yxwbz.mongodb.net/rayalproduction";

            console.log('🔄 Connecting to MongoDB...');
            await mongoose.connect(MONGODB_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
            console.log('✅ Connected to MongoDB');

            const { ObjectId } = require('mongodb');
            const idToUpdate = testData._id?.$oid || testData._id;

            const db = mongoose.connection.db;
            const collection = db.collection('onlinePolicy');

            const result = await collection.updateOne(
                { _id: new ObjectId(idToUpdate) },
                { $set: updateData }
            );

            if (result.matchedCount > 0) {
                console.log(`✅ Online policy updated successfully in MongoDB! (Matched: ${result.matchedCount}, Modified: ${result.modifiedCount})`);
            } else {
                console.warn(`⚠️  No policy found with ID: ${idToUpdate}`);
            }

            await mongoose.disconnect();
            console.log('🔌 Disconnected from MongoDB');

        } catch (dbError) {
            console.error('❌ Failed to update policy via MongoDB:', dbError.message);
            console.log('   Update data that was intended:', updateData);
        }

        // Clean up temporary file
        console.log('🗑️  Cleaning up temporary files...');
        try {
            fs.unlinkSync(mergedPdfPath);
            console.log('✅ Temporary merged PDF deleted\n');
        } catch (cleanupError) {
            console.warn('⚠️  Could not delete temporary file:', cleanupError.message);
        }

        return {
            success: true,
            s3Location: s3UploadResult.Location,
            s3Key: s3Key
        };

    } catch (error) {
        console.error('\n❌ PDF Merge Flow Test Failed!');
        console.error('Error:', error.message);

        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }

        throw error;
    }
}

/**
 * Main test runner
 */
async function runAllTests() {
    console.log('='.repeat(80));
    console.log('BRISK API AND PDF MERGE FLOW TEST');
    console.log('='.repeat(80));
    console.log('');

    let briskResult = null;
    let mergeResult = null;

    try {
        // Test 1: Brisk API
        briskResult = await testBriskAPI();
        console.log('✅ Brisk API Test Passed!\n');

        // Test 2: PDF Merge Flow
        mergeResult = await testPDFMergeFlow();
        console.log('✅ PDF Merge Flow Test Passed!\n');

        // Final Summary
        console.log('='.repeat(80));
        console.log('✅ ✅ ✅ ALL TESTS COMPLETED SUCCESSFULLY! ✅ ✅ ✅');
        console.log('='.repeat(80));
        console.log('\nSummary:');
        console.log(`  📄 Brisk Certificate:`);
        console.log(`     - Policy ID: ${briskResult.policyId}`);
        console.log(`     - Download URL: ${briskResult.downloadUrl}`);
        console.log(`     - Local Path: ${briskResult.localPath}`);
        console.log(`\n  📄 Merged PDF:`);
        console.log(`     - S3 Location: ${mergeResult.s3Location}`);
        console.log(`     - S3 Key: ${mergeResult.s3Key}`);
        console.log(`     - Policy ID: ${testData.policyId}`);
        console.log('');

        process.exit(0);

    } catch (error) {
        console.error('\n' + '='.repeat(80));
        console.error('❌ ❌ ❌ TEST FAILED! ❌ ❌ ❌');
        console.error('='.repeat(80));
        console.error('\nError:', error.message);

        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }

        process.exit(1);
    }
}

// Run all tests
runAllTests();

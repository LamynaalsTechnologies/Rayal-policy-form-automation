/**
 * 🛡️ Enhanced Error Handler
 * Comprehensive error handling for policy form automation
 * 
 * CRITICAL: Money is involved - errors must be tracked meticulously
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// ERROR CODES - Structured error classification for debugging and reporting
// ============================================================================

const ERROR_CODES = {
    // Validation Errors (100-199) - Client/Input errors
    E100_INVALID_INPUT: { code: 'E100', message: 'Invalid input data', severity: 'warning', retryable: false },
    E101_MISSING_REQUIRED_FIELD: { code: 'E101', message: 'Missing required field', severity: 'warning', retryable: false },
    E102_INVALID_FORMAT: { code: 'E102', message: 'Invalid data format', severity: 'warning', retryable: false },
    E103_DUPLICATE_SUBMISSION: { code: 'E103', message: 'Duplicate submission detected', severity: 'warning', retryable: false },
    E104_INVALID_MOBILE: { code: 'E104', message: 'Invalid mobile number format', severity: 'warning', retryable: false },
    E105_INVALID_EMAIL: { code: 'E105', message: 'Invalid email format', severity: 'warning', retryable: false },
    E106_INVALID_AADHAR: { code: 'E106', message: 'Invalid Aadhar number', severity: 'warning', retryable: false },
    E107_INVALID_PIN: { code: 'E107', message: 'Invalid PIN code', severity: 'warning', retryable: false },
    E108_INVALID_DATE: { code: 'E108', message: 'Invalid date format', severity: 'warning', retryable: false },
    E109_INVALID_IDV: { code: 'E109', message: 'Invalid IDV value', severity: 'warning', retryable: false },

    // Authentication Errors (200-299)
    E200_LOGIN_FAILED: { code: 'E200', message: 'Login failed', severity: 'error', retryable: true },
    E201_SESSION_EXPIRED: { code: 'E201', message: 'Session expired', severity: 'warning', retryable: true },
    E202_CAPTCHA_FAILED: { code: 'E202', message: 'Captcha resolution failed', severity: 'warning', retryable: true },
    E203_INVALID_CREDENTIALS: { code: 'E203', message: 'Invalid credentials', severity: 'error', retryable: false },
    E204_ACCOUNT_LOCKED: { code: 'E204', message: 'Account locked', severity: 'critical', retryable: false },

    // Form Processing Errors (300-399)
    E300_FORM_SUBMISSION_FAILED: { code: 'E300', message: 'Form submission failed', severity: 'error', retryable: true },
    E301_ELEMENT_NOT_FOUND: { code: 'E301', message: 'Page element not found', severity: 'warning', retryable: true },
    E302_TIMEOUT: { code: 'E302', message: 'Operation timed out', severity: 'warning', retryable: true },
    E303_CALCULATION_FAILED: { code: 'E303', message: 'Premium calculation failed', severity: 'error', retryable: true },
    E304_PAGE_LOAD_FAILED: { code: 'E304', message: 'Page failed to load', severity: 'warning', retryable: true },
    E305_MODAL_ERROR: { code: 'E305', message: 'Modal dialog error', severity: 'warning', retryable: true },
    E306_DROPDOWN_ERROR: { code: 'E306', message: 'Dropdown selection failed', severity: 'warning', retryable: true },
    E307_UPLOAD_FIELD_ERROR: { code: 'E307', message: 'File upload failed on form', severity: 'warning', retryable: true },
    E308_FORM_VALIDATION_FAILED: { code: 'E308', message: 'Server-side form validation failed', severity: 'warning', retryable: false },

    // Post-Submission Errors (400-499) - CRITICAL: Money involved
    E400_PAYMENT_FAILED: { code: 'E400', message: 'Payment processing failed', severity: 'critical', retryable: false },
    E401_TRANSACTION_INCOMPLETE: { code: 'E401', message: 'Transaction incomplete', severity: 'critical', retryable: false },
    E402_S3_UPLOAD_FAILED: { code: 'E402', message: 'AWS S3 upload failed', severity: 'error', retryable: true },
    E403_DB_UPDATE_FAILED: { code: 'E403', message: 'Database update failed', severity: 'error', retryable: true },
    E404_POLICY_NOT_GENERATED: { code: 'E404', message: 'Policy document not generated', severity: 'critical', retryable: false },
    E405_PREMIUM_MISMATCH: { code: 'E405', message: 'Premium amount mismatch', severity: 'critical', retryable: false },

    // System Errors (500-599)
    E500_BROWSER_CRASH: { code: 'E500', message: 'Browser crashed', severity: 'error', retryable: true },
    E501_DATABASE_ERROR: { code: 'E501', message: 'Database connection error', severity: 'critical', retryable: true },
    E502_NETWORK_ERROR: { code: 'E502', message: 'Network connectivity error', severity: 'error', retryable: true },
    E503_MEMORY_ERROR: { code: 'E503', message: 'Out of memory', severity: 'critical', retryable: false },
    E504_DRIVER_ERROR: { code: 'E504', message: 'WebDriver error', severity: 'error', retryable: true },
    E505_UNKNOWN_ERROR: { code: 'E505', message: 'Unknown system error', severity: 'critical', retryable: true }
};

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Base class for all policy automation errors
 */
class PolicyAutomationError extends Error {
    constructor(errorType, details = {}, originalError = null) {
        const errorInfo = ERROR_CODES[errorType] || ERROR_CODES.E505_UNKNOWN_ERROR;

        super(details.message || errorInfo.message);

        this.name = 'PolicyAutomationError';
        this.code = errorInfo.code;
        this.errorType = errorType;
        this.severity = errorInfo.severity;
        this.retryable = errorInfo.retryable;
        this.details = details;
        this.originalError = originalError;
        this.timestamp = new Date();
        this.stack = originalError?.stack || this.stack;
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            errorType: this.errorType,
            message: this.message,
            severity: this.severity,
            retryable: this.retryable,
            details: this.details,
            timestamp: this.timestamp,
            stack: this.stack
        };
    }
}

/**
 * Validation error - Input data issues
 */
class ValidationError extends PolicyAutomationError {
    constructor(field, value, errorType = 'E100_INVALID_INPUT', details = {}) {
        super(errorType, { field, value, ...details });
        this.name = 'ValidationError';
        this.field = field;
        this.value = value;
    }
}

/**
 * Transaction error - Money-related failures (CRITICAL)
 */
class TransactionError extends PolicyAutomationError {
    constructor(transactionId, stage, errorType = 'E401_TRANSACTION_INCOMPLETE', details = {}) {
        super(errorType, { transactionId, stage, ...details });
        this.name = 'TransactionError';
        this.transactionId = transactionId;
        this.stage = stage;
    }
}

/**
 * Session error - Browser/login issues
 */
class SessionError extends PolicyAutomationError {
    constructor(sessionId, errorType = 'E201_SESSION_EXPIRED', details = {}) {
        super(errorType, { sessionId, ...details });
        this.name = 'SessionError';
        this.sessionId = sessionId;
    }
}

// ============================================================================
// INPUT VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate complete form data
 * @param {Object} formData - Form data to validate
 * @param {string} company - Company type (reliance/national)
 * @returns {Object} { valid: boolean, errors: Array }
 */
function validateFormData(formData, company = 'reliance') {
    const errors = [];

    // Required fields for all companies
    const requiredFields = [
        { field: 'firstName', label: 'First Name' },
        { field: 'lastName', label: 'Last Name' },
        { field: 'dob', label: 'Date of Birth' },
        { field: 'mobile', label: 'Mobile Number' },
        { field: 'email', label: 'Email' },
        { field: 'pinCode', label: 'PIN Code' }
    ];

    // Check required fields
    for (const { field, label } of requiredFields) {
        if (!formData[field] || String(formData[field]).trim() === '') {
            errors.push(new ValidationError(field, formData[field], 'E101_MISSING_REQUIRED_FIELD', {
                message: `${label} is required`
            }));
        }
    }

    // Validate mobile number (10 digits)
    if (formData.mobile) {
        const mobile = String(formData.mobile).replace(/\D/g, '');
        if (mobile.length !== 10) {
            errors.push(new ValidationError('mobile', formData.mobile, 'E104_INVALID_MOBILE', {
                message: 'Mobile number must be 10 digits'
            }));
        }
    }

    // Validate email format
    if (formData.email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(formData.email)) {
            errors.push(new ValidationError('email', formData.email, 'E105_INVALID_EMAIL', {
                message: 'Invalid email format'
            }));
        }
    }

    // Validate Aadhar (12 digits)
    if (formData.aadhar) {
        const aadhar = String(formData.aadhar).replace(/\D/g, '');
        if (aadhar.length !== 12) {
            errors.push(new ValidationError('aadhar', formData.aadhar, 'E106_INVALID_AADHAR', {
                message: 'Aadhar number must be 12 digits'
            }));
        }
    }

    // Validate PIN code (6 digits)
    if (formData.pinCode) {
        const pin = String(formData.pinCode).replace(/\D/g, '');
        if (pin.length !== 6) {
            errors.push(new ValidationError('pinCode', formData.pinCode, 'E107_INVALID_PIN', {
                message: 'PIN code must be 6 digits'
            }));
        }
    }

    // Validate date format (DD-MM-YYYY)
    if (formData.dob) {
        const dateRegex = /^\d{2}-\d{2}-\d{4}$/;
        if (!dateRegex.test(formData.dob)) {
            errors.push(new ValidationError('dob', formData.dob, 'E108_INVALID_DATE', {
                message: 'Date must be in DD-MM-YYYY format'
            }));
        }
    }

    // Validate IDV (if provided, must be positive number)
    if (formData.idv !== undefined && formData.idv !== null) {
        const idv = Number(formData.idv);
        if (isNaN(idv) || idv <= 0) {
            errors.push(new ValidationError('idv', formData.idv, 'E109_INVALID_IDV', {
                message: 'IDV must be a positive number'
            }));
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors,
        errorSummary: errors.map(e => `${e.field}: ${e.message}`).join('; ')
    };
}

/**
 * Sanitize and normalize form data
 * @param {Object} formData - Raw form data
 * @returns {Object} Sanitized form data
 */
function sanitizeFormData(formData) {
    const sanitized = { ...formData };

    // Trim all string values
    for (const key of Object.keys(sanitized)) {
        if (typeof sanitized[key] === 'string') {
            sanitized[key] = sanitized[key].trim();
        }
    }

    // Normalize mobile (remove spaces, dashes)
    if (sanitized.mobile) {
        sanitized.mobile = String(sanitized.mobile).replace(/[\s-]/g, '');
    }

    // Normalize aadhar (remove spaces)
    if (sanitized.aadhar) {
        sanitized.aadhar = String(sanitized.aadhar).replace(/\s/g, '');
    }

    // Normalize pinCode
    if (sanitized.pinCode) {
        sanitized.pinCode = String(sanitized.pinCode).replace(/\D/g, '');
    }

    // Normalize names (capitalize first letter)
    const nameFields = ['firstName', 'lastName', 'middleName', 'fatherName'];
    for (const field of nameFields) {
        if (sanitized[field]) {
            sanitized[field] = capitalizeWords(sanitized[field]);
        }
    }

    return sanitized;
}

/**
 * Capitalize first letter of each word
 */
function capitalizeWords(str) {
    return str.replace(/\b\w/g, char => char.toUpperCase());
}

// ============================================================================
// ERROR CLASSIFICATION & HANDLING
// ============================================================================

/**
 * Classify error from error message or exception
 * @param {Error} error - The error to classify
 * @returns {Object} Classified error info
 */
function classifyError(error) {
    const message = error.message?.toLowerCase() || '';

    // Check for specific error patterns
    if (message.includes('session') || message.includes('expired')) {
        return ERROR_CODES.E201_SESSION_EXPIRED;
    }
    if (message.includes('captcha')) {
        return ERROR_CODES.E202_CAPTCHA_FAILED;
    }
    if (message.includes('login') || message.includes('credential')) {
        return ERROR_CODES.E200_LOGIN_FAILED;
    }
    if (message.includes('timeout') || message.includes('timed out')) {
        return ERROR_CODES.E302_TIMEOUT;
    }
    if (message.includes('element') || message.includes('not found') || message.includes('no such element')) {
        return ERROR_CODES.E301_ELEMENT_NOT_FOUND;
    }
    if (message.includes('renderer') || message.includes('crashed') || message.includes('target window')) {
        return ERROR_CODES.E500_BROWSER_CRASH;
    }
    if (message.includes('network') || message.includes('econnrefused') || message.includes('connection')) {
        return ERROR_CODES.E502_NETWORK_ERROR;
    }
    if (message.includes('payment') || message.includes('transaction')) {
        return ERROR_CODES.E400_PAYMENT_FAILED;
    }
    if (message.includes('s3') || message.includes('upload')) {
        return ERROR_CODES.E402_S3_UPLOAD_FAILED;
    }
    if (message.includes('database') || message.includes('mongodb')) {
        return ERROR_CODES.E501_DATABASE_ERROR;
    }
    if (message.includes('modal') || message.includes('popup')) {
        return ERROR_CODES.E305_MODAL_ERROR;
    }
    if (message.includes('dropdown') || message.includes('select')) {
        return ERROR_CODES.E306_DROPDOWN_ERROR;
    }
    if (message.includes('validation') && message.includes('failed')) {
        return ERROR_CODES.E308_FORM_VALIDATION_FAILED;
    }

    // Default to unknown
    return ERROR_CODES.E505_UNKNOWN_ERROR;
}

/**
 * Format error for logging
 * @param {Error} error - Error to format
 * @param {Object} context - Additional context
 * @returns {Object} Formatted error object
 */
function formatErrorForLog(error, context = {}) {
    const classified = error instanceof PolicyAutomationError
        ? error.toJSON()
        : {
            ...classifyError(error),
            message: error.message,
            stack: error.stack
        };

    return {
        ...classified,
        context: {
            ...context,
            timestamp: new Date().toISOString(),
            nodeEnv: process.env.NODE_ENV || 'development'
        }
    };
}

/**
 * Create a structured error log entry for MongoDB
 * @param {Error} error - The error
 * @param {number} attemptNumber - Current attempt
 * @param {string} stage - Processing stage
 * @param {Object} additionalInfo - Extra info
 * @returns {Object} Error log entry
 */
function createErrorLogEntry(error, attemptNumber, stage, additionalInfo = {}) {
    const classified = classifyError(error);

    return {
        timestamp: new Date(),
        attemptNumber: attemptNumber,
        errorCode: classified.code,
        errorType: error instanceof PolicyAutomationError ? error.errorType : 'UNCLASSIFIED',
        errorMessage: error.message,
        severity: classified.severity,
        retryable: classified.retryable,
        stage: stage,
        stack: error.stack,
        additionalInfo: additionalInfo,
        screenshotUrl: null,
        screenshotKey: null
    };
}

// ============================================================================
// RETRY LOGIC
// ============================================================================

/**
 * Determine if error should trigger retry
 * @param {Error} error - The error
 * @param {number} currentAttempt - Current attempt number
 * @param {number} maxAttempts - Maximum attempts
 * @returns {boolean} Should retry
 */
function shouldRetry(error, currentAttempt, maxAttempts = 3) {
    if (currentAttempt >= maxAttempts) {
        return false;
    }

    if (error instanceof PolicyAutomationError) {
        return error.retryable;
    }

    const classified = classifyError(error);
    return classified.retryable;
}

/**
 * Calculate retry delay with exponential backoff
 * @param {number} attempt - Current attempt (1-indexed)
 * @param {number} baseDelay - Base delay in ms
 * @param {number} maxDelay - Maximum delay in ms
 * @returns {number} Delay in ms
 */
function calculateRetryDelay(attempt, baseDelay = 5000, maxDelay = 60000) {
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000; // Add 0-1s jitter
    return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Execute with retry logic
 * @param {Function} fn - Function to execute
 * @param {Object} options - Retry options
 * @returns {Promise} Result of function
 */
async function executeWithRetry(fn, options = {}) {
    const {
        maxAttempts = 3,
        baseDelay = 5000,
        maxDelay = 60000,
        onRetry = () => { },
        onError = () => { }
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            onError(error, attempt);

            if (!shouldRetry(error, attempt, maxAttempts)) {
                throw error;
            }

            if (attempt < maxAttempts) {
                const delay = calculateRetryDelay(attempt, baseDelay, maxDelay);
                console.log(`[Retry] Attempt ${attempt}/${maxAttempts} failed. Retrying in ${Math.round(delay / 1000)}s...`);
                await onRetry(error, attempt, delay);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

// ============================================================================
// IDEMPOTENCY & DUPLICATE DETECTION
// ============================================================================

/**
 * Generate idempotency key for a job
 * @param {Object} formData - Form data
 * @returns {string} Idempotency key
 */
function generateIdempotencyKey(formData) {
    const keyComponents = [
        formData.mobile,
        formData.email,
        formData.chassisNumber || '',
        formData.engineNumber || '',
        new Date().toISOString().split('T')[0] // Include date
    ];

    const crypto = require('crypto');
    return crypto.createHash('md5').update(keyComponents.join('|')).digest('hex');
}

/**
 * Check for duplicate submission
 * @param {Object} collection - MongoDB collection
 * @param {string} idempotencyKey - The key to check
 * @param {number} windowMinutes - Time window in minutes
 * @returns {Promise<Object|null>} Existing job if duplicate
 */
async function checkDuplicateSubmission(collection, idempotencyKey, windowMinutes = 60) {
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

    const existingJob = await collection.findOne({
        idempotencyKey: idempotencyKey,
        createdAt: { $gte: windowStart },
        status: { $in: ['pending', 'processing', 'completed'] }
    });

    return existingJob;
}

// ============================================================================
// STATE MACHINE FOR JOB STATUS
// ============================================================================

const JOB_STATES = {
    pending: {
        allowedTransitions: ['processing', 'failed_login_form'],
        final: false
    },
    processing: {
        allowedTransitions: ['completed', 'failed_login_form', 'failed_post_submission', 'pending'],
        final: false
    },
    completed: {
        allowedTransitions: [],
        final: true
    },
    failed_login_form: {
        allowedTransitions: ['pending'], // Can be retried
        final: false
    },
    failed_post_submission: {
        allowedTransitions: [], // Cannot be retried - money involved
        final: true
    }
};

/**
 * Validate state transition
 * @param {string} currentState - Current job state
 * @param {string} newState - Desired new state
 * @returns {boolean} Is transition valid
 */
function isValidStateTransition(currentState, newState) {
    const stateConfig = JOB_STATES[currentState];
    if (!stateConfig) {
        return false;
    }
    return stateConfig.allowedTransitions.includes(newState);
}

/**
 * Transition job to new state with validation
 * @param {Object} collection - MongoDB collection
 * @param {ObjectId} jobId - Job ID
 * @param {string} currentState - Current state (for validation)
 * @param {string} newState - New state
 * @param {Object} additionalUpdates - Additional fields to update
 * @returns {Promise<boolean>} Success
 */
async function transitionJobState(collection, jobId, currentState, newState, additionalUpdates = {}) {
    if (!isValidStateTransition(currentState, newState)) {
        console.error(`[State Machine] Invalid transition: ${currentState} -> ${newState}`);
        return false;
    }

    const updateDoc = {
        $set: {
            status: newState,
            statusChangedAt: new Date(),
            previousStatus: currentState,
            ...additionalUpdates
        },
        $push: {
            statusHistory: {
                from: currentState,
                to: newState,
                timestamp: new Date()
            }
        }
    };

    const result = await collection.updateOne(
        { _id: jobId, status: currentState },
        updateDoc
    );

    return result.modifiedCount === 1;
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

/**
 * Log audit entry
 * @param {Object} collection - Audit collection
 * @param {string} action - Action performed
 * @param {Object} details - Action details
 */
async function logAudit(collection, action, details) {
    try {
        await collection.insertOne({
            action: action,
            details: details,
            timestamp: new Date(),
            nodeVersion: process.version,
            hostname: require('os').hostname()
        });
    } catch (error) {
        console.error('[Audit] Failed to log audit entry:', error.message);
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Error Codes
    ERROR_CODES,

    // Custom Error Classes
    PolicyAutomationError,
    ValidationError,
    TransactionError,
    SessionError,

    // Validation
    validateFormData,
    sanitizeFormData,

    // Error Handling
    classifyError,
    formatErrorForLog,
    createErrorLogEntry,

    // Retry Logic
    shouldRetry,
    calculateRetryDelay,
    executeWithRetry,

    // Idempotency
    generateIdempotencyKey,
    checkDuplicateSubmission,

    // State Machine
    JOB_STATES,
    isValidStateTransition,
    transitionJobState,

    // Audit
    logAudit
};

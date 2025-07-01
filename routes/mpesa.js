const express = require('express');
const axios = require('axios');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Database to store payment requests (in production, use a real database)
const paymentRequests = new Map();

// M-Pesa credentials
const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_BUSINESS_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL
} = process.env;

// Generate M-Pesa access token
const getAccessToken = async () => {
  try {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    
    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
       throw new Error("M-Pesa credentials are not configured");
    }
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );
    
    console.log("Generated M-Pesa token:", response.data.access_token);
    return response.data.access_token;
  } catch (error) {
    console.error("M-Pesa token error:", error.response?.data || error.message);
    throw new Error("Failed to generate M-Pesa token");
  }
};

// Initiate M-Pesa payment
router.post('/payment', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${MPESA_BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    
    // Sanitize phone number
    let formattedPhone = phone.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('7')) {
      formattedPhone = '254' + formattedPhone;
    }
    
    // Get access token using the new function
    const accessToken = await getAccessToken();
    
    // Initiate STK push
    const stkResponse = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: MPESA_BUSINESS_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: MPESA_BUSINESS_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: "Declutter Purchase",
        TransactionDesc: "Payment for items"
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Store payment request with initial status
    const checkoutRequestId = stkResponse.data.CheckoutRequestID;
    paymentRequests.set(checkoutRequestId, {
      status: 'pending',
      data: stkResponse.data,
      createdAt: new Date()
    });

    res.json(stkResponse.data);
  } catch (error) {
    console.error("M-Pesa payment error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to initiate M-Pesa payment" });
  }
});

// M-Pesa callback handler
router.post('/callback', (req, res) => {
  console.log("M-Pesa Callback Received:", req.body);
  
  // Here you would:
  // 1. Verify the payment status
  // 2. Update your database
  // 3. Send notifications to user/admin
  // 4. Trigger any post-payment actions
  
  try {
    const callback = req.body;
    if (callback.Body && callback.Body.stkCallback) {
      const { CheckoutRequestID, ResultCode, CallbackMetadata } = callback.Body.stkCallback;
      
      if (ResultCode === 0) {
        const metadata = {};
        if (CallbackMetadata && CallbackMetadata.Item) {
          CallbackMetadata.Item.forEach(item => {
            metadata[item.Name] = item.Value;
          });
        }
        
        paymentRequests.set(CheckoutRequestID, {
          status: 'success',
          data: metadata,
          updatedAt: new Date()
        });
      } else {
        paymentRequests.set(CheckoutRequestID, {
          status: 'failed',
          data: callback,
          updatedAt: new Date()
        });
      }
    }
    
    res.status(200).send();
  } catch (error) {
    console.error("Callback error:", error);
    res.status(500).send();
  }
});

// Check payment status
router.get('/payment-status/:checkoutRequestId', (req, res) => {
  const { checkoutRequestId } = req.params;
  const paymentRequest = paymentRequests.get(checkoutRequestId);
  
  if (!paymentRequest) {
    return res.status(404).json({ error: 'Payment request not found' });
  }
  
  res.json({
    status: paymentRequest.status,
    data: paymentRequest.data
  });
});

// // Add transaction status endpoint
// router.post('/transaction-status', async (req, res) => {
//   try {
//     const { transactionID } = req.body;
//     const accessToken = await getAccessToken();
    
//     const response = await axios.post(
//       'https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query',
//       {
//         Initiator: process.env.MPESA_INITIATOR,
//         SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
//         CommandID: 'TransactionStatusQuery',
//         TransactionID: transactionID,
//         PartyA: process.env.MPESA_BUSINESS_SHORTCODE,
//         IdentifierType: '4',
//         ResultURL: `${process.env.MPESA_CALLBACK_URL}/transaction-status`,
//         QueueTimeOutURL: `${process.env.MPESA_CALLBACK_URL}/timeout`,
//         Remarks: 'Transaction status check',
//         Occasion: 'Check status'
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${accessToken}`,
//           'Content-Type': 'application/json'
//         }
//       }
//     );
    
//     res.json(response.data);
//   } catch (error) {
//     console.error("Transaction status error:", error.response?.data || error.message);
//     res.status(500).json({ error: "Failed to check transaction status" });
//   }
// });

module.exports = router;
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
    
     // After getting stkResponse
    const checkoutRequestId = stkResponse.data.CheckoutRequestID;

    // Store payment request in database
    const { error } = await supabase
      .from('mpesa_payments')
      .insert([{
        checkout_request_id: checkoutRequestId,
        phone: formattedPhone,
        amount: amount,
        status: 'pending'
      }]);
    
    if (error) {
      console.error('Supabase insert error:', error);
      throw new Error('Failed to store payment record');
    }

    res.json(stkResponse.data);
  } catch (error) {
    console.error("M-Pesa payment error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to initiate M-Pesa payment" });
  }
});

// M-Pesa callback handler
router.post('/callback', async (req, res) => {
  console.log("M-Pesa Callback Received:", req.body);
  
  try {
    const callback = req.body;

     if (callback.Body?.stkCallback) {
      const { CheckoutRequestID, ResultCode } = callback.Body.stkCallback;
      const status = ResultCode == 0 ? 'success' : 'failed';
      
      // Update status in mpesa_payments table
      const { error } = await supabase
        .from('mpesa_payments')
        .update({ status })
        .eq('checkout_request_id', CheckoutRequestID);
      
      if (error) {
        console.error('Supabase update error:', error);
        throw error;
      }
    }
    
    res.status(200).send();
  } catch (error) {
    console.error("Callback error:", error);
    res.status(500).send();
  }
});

// Check Payment Status (query table)
router.get('/payment-status/:checkoutRequestId', async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;
    
    // Query mpesa_payments table
    const { data, error } = await supabase
      .from('mpesa_payments')
      .select('status')
      .eq('checkout_request_id', checkoutRequestId)
      .single();

    if (error) throw error;
    
    if (!data) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    
    res.json({
      status: data.status,
    });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
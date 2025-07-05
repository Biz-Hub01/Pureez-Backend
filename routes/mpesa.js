const express = require("express");
const axios = require("axios");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Validate environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Supabase environment variables missing!");
  // Instead of crashing, we'll log an error but let the server start
}

// M-Pesa credentials
const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_BUSINESS_SHORTCODE,
  MPESA_PASSKEY,
} = process.env;

// Generate M-Pesa access token
const getAccessToken = async () => {
  try {
    const auth = Buffer.from(
      `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
      throw new Error("M-Pesa credentials are not configured");
    }

    const response = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` }, timeout: 90000 }
    );

    console.log("Generated M-Pesa token:", response.data.access_token);
    return response.data.access_token;
  } catch (error) {
    console.error("M-Pesa token error:", error.response?.data || error.message);
    throw new Error("Failed to generate M-Pesa token");
  }
};

// Generate timestamp in required format (YYYYMMDDHHmmss)
const getTimestamp = () => {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
};

// Initiate M-Pesa payment
router.post("/payment", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const accessToken = await getAccessToken();
    const timestamp = getTimestamp();

    const password = Buffer.from(
      `${MPESA_BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    // Sanitize phone number
    let formattedPhone = String(phone).replace(/\D/g, "");
    if (formattedPhone.startsWith("0") && formattedPhone.length === 10) {
      formattedPhone = "254" + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith("7") && formattedPhone.length === 9) {
      formattedPhone = "254" + formattedPhone;
    }

    // Validate phone format
    if (!/^254[17]\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({
        error: "Invalid phone number",
        details: "Please provide a valid Kenyan phone number"
      });
    }

    // Initiate STK push
    const stkResponse = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: MPESA_BUSINESS_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: MPESA_BUSINESS_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: `${process.env.VITE_BACKEND_URL}/api/mpesa/callback`,
        AccountReference: "DeclutterAtPureez Purchase",
        TransactionDesc: "Payment for items",
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    // After getting stkResponse
    const checkoutRequestId = stkResponse.data.CheckoutRequestID;

    // Store payment request in database
    const { error: insertError } = await supabase
      .from("mpesa_payments")
      .insert([
        {
          checkout_request_id: checkoutRequestId,
          phone: formattedPhone,
          amount: amount,
          status: "pending",
        },
      ]);

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      // Return error response instead of throwing
      return res.status(500).json({
        error: "Database error",
        details: insertError.message,
      });
    }

    res.json({
      ResponseCode: "0",
      CheckoutRequestID: checkoutRequestId,
      ResponseDescription: "Request sent successfully",
    });

  } catch (error) {
    console.error("M-Pesa payment error:", error.message);

    // Check if headers haven't been sent yet
    if (!res.headersSent) {
      let errorDetails = "Internal server error";
      if (error.response) {
        errorDetails = error.response.data.errorMessage || 
                      error.response.data || 
                      `HTTP ${error.response.status}`;
      }

    res.status(500).json({
      error: "Failed to initiate payment",
      details: errorDetails,
    });
  } else {
      console.error('Cannot send error response - headers already sent');
    }
  }
});

// M-Pesa callback handler
router.post("/callback", async (req, res) => {
  try {
    const callback = req.body;

    if (callback.Body?.stkCallback) {
      const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } =
        callback.Body.stkCallback;

      const status = ResultCode == 0 ? "success" : "failed";

      console.log(
        `Payment status for ${CheckoutRequestID}: ${status} - ${ResultDesc}`
      );

      // Extract payment details
      let mpesaReceiptNumber = "";
      let transactionDate = "";

      if (CallbackMetadata?.Item) {
        // Handle both array and object formats
        const items = Array.isArray(CallbackMetadata.Item) 
          ? CallbackMetadata.Item 
          : [CallbackMetadata.Item];
          
        for (const item of items) {
          if (item.Name === "MpesaReceiptNumber") {
            mpesaReceiptNumber = item.Value || "";
          }
          if (item.Name === "TransactionDate") {
            transactionDate = item.Value || "";
          }
        }
      }

      // Update payment status in mpesa_payments table
      await supabase
        .from("mpesa_payments")
        .update({
          status,
          mpesa_receipt_number: mpesaReceiptNumber,
          transaction_date: transactionDate,
        })
        .eq("checkout_request_id", CheckoutRequestID);

      console.log(`Payment updated: ${CheckoutRequestID} - ${status}`);
    }

    res.status(200).send();
  } catch (error) {
    console.error("Callback error:", error);
    res.status(500).send();
  }
});

// Check Payment Status via STK Push Query
router.get("/payment-status/:checkoutRequestId", async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    // Validate input
    if (!checkoutRequestId) {
      return res.status(400).json({
        error: "Invalid request",
        details: "Missing checkout request ID"
      });
    }

    // Fetch mpesa_payments table with status
    const { data, error } = await supabase
      .from("mpesa_payments")
      .select("status")
      .eq("checkout_request_id", checkoutRequestId)
      .single();

    if (error) throw error;
    
    // Return status from database
    return res.json({ status: data?.status || "pending" });

  } catch (error) {
    console.error("Payment status error:", error );
    // Return pending status on any error
    return res.json({ status: "pending" });
  }
});

module.exports = router;

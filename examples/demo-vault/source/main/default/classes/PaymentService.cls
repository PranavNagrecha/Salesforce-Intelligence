/**
 * Applies payments against invoices. Updates the invoice's running paid total
 * (Invoice__c.Total_Paid__c is a roll-up of Payment__c.Amount__c) and marks the
 * invoice Paid when fully covered.
 */
public with sharing class PaymentService {

    /**
     * Apply a payment to an invoice.
     *
     * @param invoiceId the invoice receiving the payment
     * @param amount    the payment amount (Payment__c.Amount__c)
     * @param method    the payment method picklist value
     * @return the inserted Payment__c record
     */
    public static Payment__c applyPayment(Id invoiceId, Decimal amount, String method) {
        Invoice__c invoice = [
            SELECT Id, Amount__c, Total_Paid__c, Status__c
            FROM Invoice__c
            WHERE Id = :invoiceId
            LIMIT 1
        ];

        Payment__c payment = new Payment__c(
            Invoice__c = invoiceId,
            Amount__c = amount,
            Payment_Date__c = Date.today(),
            Method__c = method
        );
        insert payment;

        // Total_Paid__c is maintained by the roll-up, but we read it here to
        // decide whether the invoice is now fully paid.
        Decimal priorPaid = invoice.Total_Paid__c == null ? 0 : invoice.Total_Paid__c;
        Decimal newPaid = priorPaid + amount;

        if (invoice.Amount__c != null && newPaid >= invoice.Amount__c) {
            invoice.Status__c = 'Paid';
            update invoice;
        }

        return payment;
    }
}

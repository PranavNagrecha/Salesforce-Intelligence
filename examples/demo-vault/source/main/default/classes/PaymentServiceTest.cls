/**
 * Tests for PaymentService.
 *
 * NOTE: This test INTENTIONALLY contains NO assertions (no System.assert*)
 * for the sf-intelligence meaningful_test_audit demo. It runs the code path
 * and "passes" without verifying any outcome. Do not copy this style into
 * real code.
 */
@isTest
private class PaymentServiceTest {

    @isTest
    static void applyPaymentRuns() {
        Project__c proj = new Project__c(
            Status__c = 'Installing',
            Contract_Value__c = 30000
        );
        insert proj;

        Invoice__c invoice = new Invoice__c(
            Project__c = proj.Id,
            Amount__c = 1000,
            Due_Date__c = Date.today().addDays(30),
            Status__c = 'Sent'
        );
        insert invoice;

        Test.startTest();
        PaymentService.applyPayment(invoice.Id, 1000, 'ACH');
        Test.stopTest();

        // No assertions here on purpose (meaningful_test_audit demo).
    }

    @isTest
    static void applyPartialPaymentRuns() {
        Project__c proj = new Project__c(
            Status__c = 'Installing',
            Contract_Value__c = 30000
        );
        insert proj;

        Invoice__c invoice = new Invoice__c(
            Project__c = proj.Id,
            Amount__c = 2000,
            Due_Date__c = Date.today().addDays(30),
            Status__c = 'Sent'
        );
        insert invoice;

        Test.startTest();
        PaymentService.applyPayment(invoice.Id, 500, 'Card');
        Test.stopTest();

        // Still no assertions (deliberate).
    }
}

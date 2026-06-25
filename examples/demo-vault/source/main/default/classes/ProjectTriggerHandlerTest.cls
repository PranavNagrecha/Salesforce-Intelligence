/**
 * Tests for ProjectTriggerHandler. This is a REAL test: it exercises the
 * risk-score derivation and asserts the expected outcomes (System.assert*).
 */
@isTest
private class ProjectTriggerHandlerTest {

    @isTest
    static void draftHighValueProjectGetsElevatedRisk() {
        Project__c proj = new Project__c(
            Status__c = 'Draft',
            Contract_Value__c = 120000
        );

        Test.startTest();
        insert proj;
        Test.stopTest();

        Project__c reloaded = [
            SELECT Id, Risk_Score__c
            FROM Project__c
            WHERE Id = :proj.Id
            LIMIT 1
        ];

        // Draft (40) + value > 100000 (20) = 60.
        System.assertEquals(60, reloaded.Risk_Score__c,
            'Draft high-value project should score 60');
    }

    @isTest
    static void completeLowValueProjectGetsLowRisk() {
        Project__c proj = new Project__c(
            Status__c = 'Complete',
            Contract_Value__c = 10000,
            Permit_Approved__c = true
        );

        Test.startTest();
        insert proj;
        Test.stopTest();

        Project__c reloaded = [
            SELECT Id, Risk_Score__c, Status__c
            FROM Project__c
            WHERE Id = :proj.Id
            LIMIT 1
        ];

        System.assertEquals('Complete', reloaded.Status__c,
            'Status should persist as Complete');
        System.assert(reloaded.Risk_Score__c < 20,
            'Complete low-value project should score under 20');
    }

    @isTest
    static void cancelledProjectGetsHighRisk() {
        Project__c proj = new Project__c(
            Status__c = 'Draft',
            Contract_Value__c = 5000
        );
        insert proj;

        proj.Status__c = 'Cancelled';

        Test.startTest();
        update proj;
        Test.stopTest();

        Project__c reloaded = [
            SELECT Id, Risk_Score__c
            FROM Project__c
            WHERE Id = :proj.Id
            LIMIT 1
        ];

        System.assert(reloaded.Risk_Score__c >= 80,
            'Cancelled project should score at least 80');
    }
}

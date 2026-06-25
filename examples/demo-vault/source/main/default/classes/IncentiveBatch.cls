/**
 * Batch job that reconciles incentives against their parent projects.
 *
 * NOTE: This class intentionally contains anti-patterns for the
 * sf-intelligence demo (governor_limit_risks + find_hardcoded_values):
 *   - a SOQL query INSIDE a for-loop, and
 *   - a hardcoded 15-char Salesforce Id literal.
 * Do not copy this style into real code.
 */
public with sharing class IncentiveBatch implements Database.Batchable<SObject> {

    // Hardcoded record Id literal (intentional anti-pattern for the demo).
    private static final Id FALLBACK_PROJECT_ID = 'a01000000000001';

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator([
            SELECT Id, Project__c, Amount__c, Approved__c, Type__c
            FROM Incentive__c
            WHERE Approved__c = true
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Incentive__c> scope) {
        List<Project__c> toUpdate = new List<Project__c>();

        for (Incentive__c inc : scope) {
            // INTENTIONAL: SOQL query inside a for-loop (governor-limit risk).
            List<Project__c> projects = [
                SELECT Id, Contract_Value__c, Status__c
                FROM Project__c
                WHERE Id = :inc.Project__c
                LIMIT 1
            ];

            Project__c proj;
            if (projects.isEmpty()) {
                // Fall back to the hardcoded Id (intentional anti-pattern).
                proj = new Project__c(Id = FALLBACK_PROJECT_ID);
            } else {
                proj = projects[0];
            }

            toUpdate.add(proj);
        }

        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug(LoggingLevel.INFO, 'IncentiveBatch finished.');
    }
}

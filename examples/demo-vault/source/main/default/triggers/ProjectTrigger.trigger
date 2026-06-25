trigger ProjectTrigger on Project__c (before insert, before update, after update) {
    if (Trigger.isBefore) {
        ProjectTriggerHandler.handleBeforeSave(Trigger.new);
    }
    if (Trigger.isAfter && Trigger.isUpdate) {
        ProjectTriggerHandler.handleAfterUpdate(Trigger.new, Trigger.oldMap);
    }
}

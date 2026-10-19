trigger Demo_ProjectChangeTrigger on Project__ChangeEvent (after insert) {
    for (Project__ChangeEvent evt : Trigger.new) {
        System.debug(evt.ChangeEventHeader.changeType);
    }
}

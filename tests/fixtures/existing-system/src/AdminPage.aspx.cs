public sealed class AdminPage
{
    public void DeleteOrder(int orderId)
    {
        OrderService.Delete(orderId);
    }
}

export function AvatarStack({ count }: { count: number }) {
  return (
    <div className="flex -space-x-2">
      {Array.from({ length: count }).map((_, index) => (
        <img
          key={index}
          src={`https://i.pravatar.cc/48?img=${12 + index}`}
          alt="Member avatar"
          className="h-5 w-5 rounded-full border-2 border-white object-cover"
        />
      ))}
    </div>
  )
}
